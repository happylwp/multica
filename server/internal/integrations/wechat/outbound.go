package wechat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	outboundQueueSize = 64
	taskFailedText    = "❌ 智能体运行失败，请重试。"
)

type outboundQueries interface {
	GetChannelTaskDelivery(ctx context.Context, taskID pgtype.UUID) (db.ChannelTaskDelivery, error)
	GetChannelInstallation(ctx context.Context, arg db.GetChannelInstallationParams) (db.ChannelInstallation, error)
}

// Outbound delivers an agent's chat reply back to WeChat. iLink has no
// message-edit primitive, so there is no streaming path — only EventChatDone
// and EventTaskFailed. Work is queued off the synchronous process bus.
type Outbound struct {
	q          outboundQueries
	decrypt    Decrypter
	encrypt    Encrypter
	quota      *QuotaStore
	persist    configPersister
	logger     *slog.Logger
	apiBase    string
	httpClient *http.Client

	work  chan events.Event
	start sync.Once
	wg    sync.WaitGroup
}

// NewOutbound builds the WeChat outbound subscriber.
func NewOutbound(q outboundQueries, decrypt Decrypter, encrypt Encrypter, quota *QuotaStore, persist configPersister, apiBase string, httpClient *http.Client, logger *slog.Logger) *Outbound {
	if logger == nil {
		logger = slog.Default()
	}
	if quota == nil {
		quota = NewQuotaStore()
	}
	return &Outbound{
		q: q, decrypt: decrypt, encrypt: encrypt, quota: quota, persist: persist,
		logger: logger, apiBase: apiBase, httpClient: httpClient,
		work: make(chan events.Event, outboundQueueSize),
	}
}

// Register subscribes to terminal chat events. iLink cannot edit in place,
// so partial TaskMessage frames are ignored.
func (o *Outbound) Register(bus *events.Bus) {
	bus.Subscribe(protocol.EventChatDone, o.enqueue)
	bus.Subscribe(protocol.EventTaskFailed, o.enqueueFailed)
}

func (o *Outbound) enqueue(e events.Event) {
	if chatDoneContent(e.Payload) == "" {
		return
	}
	select {
	case o.work <- e:
	default:
		o.logger.Error("wechat outbound: queue full, drop terminal reply")
	}
}

func (o *Outbound) enqueueFailed(e events.Event) {
	e.Payload = protocol.ChatDonePayload{Content: taskFailedText, TaskID: e.TaskID, ChatSessionID: e.ChatSessionID}
	o.enqueue(e)
}

// Start owns the delivery worker.
func (o *Outbound) Start(ctx context.Context) {
	o.start.Do(func() {
		o.wg.Add(1)
		go func() {
			defer o.wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case e := <-o.work:
					o.deliver(e)
				}
			}
		}()
	})
}

// WaitWithTimeout bounds graceful shutdown.
func (o *Outbound) WaitWithTimeout(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		o.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (o *Outbound) deliver(e events.Event) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	target, err := o.resolveTarget(ctx, e)
	if err != nil || target == nil {
		if err != nil {
			o.logger.WarnContext(ctx, "wechat outbound: resolve target failed", "error", err)
		}
		return
	}
	content := chatDoneContent(e.Payload)
	_, err = target.sender.Send(ctx, channel.OutboundMessage{ChatID: target.chatID, Text: content})
	if err != nil && !errors.Is(err, ErrWindowExpired) && !errors.Is(err, ErrQuotaExceeded) {
		o.logger.WarnContext(ctx, "wechat outbound: send failed", "error", err)
	}
}

type outboundTarget struct {
	chatID string
	sender *sender
}

func (o *Outbound) resolveTarget(ctx context.Context, e events.Event) (*outboundTarget, error) {
	taskID, ok := eventTaskID(e)
	if !ok {
		return nil, nil
	}
	delivery, err := o.q.GetChannelTaskDelivery(ctx, taskID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("lookup wechat task delivery: %w", err)
	}
	if delivery.ChannelType != channelTypeWechat {
		return nil, nil
	}
	inst, err := o.q.GetChannelInstallation(ctx, db.GetChannelInstallationParams{
		ID:          delivery.InstallationID,
		ChannelType: channelTypeWechat,
	})
	if err != nil {
		return nil, fmt.Errorf("load wechat installation: %w", err)
	}
	if inst.Status != "active" {
		return nil, nil
	}
	creds, err := decodeCredentials(inst.Config, o.decrypt)
	if err != nil {
		return nil, fmt.Errorf("decode wechat credentials: %w", err)
	}
	cfg, _ := decodeInstallConfig(inst.Config)
	hydrateQuota(o.quota, util.UUIDToString(inst.ID), cfg, o.decrypt)

	chatID := delivery.ChannelChatID
	if len(delivery.Config) > 0 {
		var bc wechatBindingConfig
		if err := json.Unmarshal(delivery.Config, &bc); err == nil && bc.ChatID != "" {
			chatID = bc.ChatID
		}
	}
	api := newILinkClient(firstNonEmpty(creds.BaseURL, o.apiBase), creds.BotToken, o.httpClient)
	return &outboundTarget{
		chatID: chatID,
		sender: newSender(api, o.quota, o.persist, o.encrypt, inst.ID, creds.SupportMarkdown, o.logger),
	}, nil
}

type wechatBindingConfig struct {
	ChatID string `json:"chat_id"`
}

func eventTaskID(e events.Event) (pgtype.UUID, bool) {
	raw := e.TaskID
	if raw == "" {
		switch p := e.Payload.(type) {
		case protocol.ChatDonePayload:
			raw = p.TaskID
		case map[string]any:
			raw, _ = p["task_id"].(string)
		}
	}
	id, err := util.ParseUUID(raw)
	return id, err == nil && id.Valid
}

func chatDoneContent(payload any) string {
	switch p := payload.(type) {
	case protocol.ChatDonePayload:
		return p.Content
	case map[string]any:
		if s, ok := p["content"].(string); ok {
			return s
		}
	}
	return ""
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
