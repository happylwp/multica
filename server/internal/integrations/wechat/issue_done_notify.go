package wechat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	issueDoneNotifyTimeout = 10 * time.Second
	issueDoneSeenTTL       = 24 * time.Hour
	issueDoneSeenMaxSize   = 4096
)

type issueDoneQueries interface {
	FindChannelBindingForMember(ctx context.Context, arg db.FindChannelBindingForMemberParams) (db.ChannelUserBinding, error)
	GetChannelInstallation(ctx context.Context, arg db.GetChannelInstallationParams) (db.ChannelInstallation, error)
	GetIssueStatusEntryByKey(ctx context.Context, arg db.GetIssueStatusEntryByKeyParams) (db.IssueStatus, error)
}

type seenEntry struct {
	at  time.Time
	seq int64
}

// IssueDoneNotifier pushes a 1:1 WeChat text when an issue reaches a
// done-category terminal status. The official 24h window is checked first:
// no inbound in 24h means the push is skipped (not a grey-path retry).
type IssueDoneNotifier struct {
	q        issueDoneQueries
	decrypt  Decrypter
	encrypt  Encrypter
	quota    *QuotaStore
	persist  configPersister
	apiBase  string
	client   *http.Client
	logger   *slog.Logger
	spawn    func(func())
	seen     sync.Map
	seenSize atomic.Int64
	seenSeq  atomic.Int64
	now      func() time.Time
}

// NewIssueDoneNotifier builds the subscriber.
func NewIssueDoneNotifier(q issueDoneQueries, decrypt Decrypter, encrypt Encrypter, quota *QuotaStore, persist configPersister, apiBase string, client *http.Client, logger *slog.Logger) *IssueDoneNotifier {
	if logger == nil {
		logger = slog.Default()
	}
	if quota == nil {
		quota = NewQuotaStore()
	}
	return &IssueDoneNotifier{
		q: q, decrypt: decrypt, encrypt: encrypt, quota: quota, persist: persist,
		apiBase: apiBase, client: client, logger: logger,
		spawn: func(f func()) { go f() },
		now:   time.Now,
	}
}

// Register subscribes to issue field updates.
func (n *IssueDoneNotifier) Register(bus *events.Bus) {
	bus.Subscribe(protocol.EventIssueUpdated, n.handleIssueUpdated)
}

func (n *IssueDoneNotifier) handleIssueUpdated(e events.Event) {
	issue, ok, statusChanged := parseIssueUpdated(e)
	if !ok || !statusChanged {
		return
	}
	wsID, err := util.ParseUUID(firstNonEmpty(issue.WorkspaceID, e.WorkspaceID))
	if err != nil || !wsID.Valid {
		return
	}
	checkCtx, checkCancel := context.WithTimeout(context.Background(), issueDoneNotifyTimeout)
	terminal := n.isDoneTerminal(checkCtx, wsID, issue.Status, issue.StatusCategory)
	checkCancel()
	if !terminal {
		return
	}
	n.spawn(func() {
		ctx, cancel := context.WithTimeout(context.Background(), issueDoneNotifyTimeout)
		defer cancel()
		if err := n.process(ctx, e, issue); err != nil {
			n.logger.WarnContext(ctx, "wechat issue-done notify: delivery failed",
				"error", err, "workspace_id", e.WorkspaceID)
		}
	})
}

func (n *IssueDoneNotifier) process(ctx context.Context, e events.Event, issue issueDoneSnapshot) error {
	wsID, err := util.ParseUUID(firstNonEmpty(issue.WorkspaceID, e.WorkspaceID))
	if err != nil || !wsID.Valid {
		return nil
	}
	if !n.isDoneTerminal(ctx, wsID, issue.Status, issue.StatusCategory) {
		return nil
	}
	body := formatIssueDoneText(issue)
	if strings.TrimSpace(body) == "" {
		return nil
	}
	var sendErrs []error
	for _, memberID := range relatedMemberIDs(issue) {
		if err := n.notifyMember(ctx, wsID, issue, memberID, body); err != nil {
			sendErrs = append(sendErrs, err)
		}
	}
	return errors.Join(sendErrs...)
}

func (n *IssueDoneNotifier) notifyMember(ctx context.Context, wsID pgtype.UUID, issue issueDoneSnapshot, memberID, body string) error {
	userID, err := util.ParseUUID(memberID)
	if err != nil || !userID.Valid {
		return nil
	}
	key := issue.ID + ":" + fmt.Sprintf("%d", issue.Revision) + ":" + issue.Status + ":" + memberID
	if _, loaded := n.seen.LoadOrStore(key, seenEntry{at: n.now(), seq: n.seenSeq.Add(1)}); loaded {
		return nil
	}
	n.seenSize.Add(1)

	binding, err := n.q.FindChannelBindingForMember(ctx, db.FindChannelBindingForMemberParams{
		WorkspaceID:   wsID,
		MulticaUserID: userID,
		ChannelType:   channelTypeWechat,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	inst, err := n.q.GetChannelInstallation(ctx, db.GetChannelInstallationParams{
		ID: binding.InstallationID, ChannelType: channelTypeWechat,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if inst.Status != "active" {
		return nil
	}
	creds, err := decodeCredentials(inst.Config, n.decrypt)
	if err != nil {
		return err
	}
	cfg, _ := decodeInstallConfig(inst.Config)
	hydrateQuota(n.quota, util.UUIDToString(inst.ID), cfg, n.decrypt)

	instKey := util.UUIDToString(inst.ID)
	chatID := binding.ChannelUserID
	if !n.quota.WindowValid(instKey, chatID, n.now()) {
		n.logger.InfoContext(ctx, "wechat issue-done notify: skipped, 24h window expired")
		return nil
	}

	api := newILinkClient(firstNonEmpty(creds.BaseURL, n.apiBase), creds.BotToken, n.client)
	_, err = newSender(api, n.quota, n.persist, n.encrypt, inst.ID, false, n.logger).
		Send(ctx, channel.OutboundMessage{ChatID: chatID, Text: body})
	if errors.Is(err, ErrWindowExpired) || errors.Is(err, ErrQuotaExceeded) {
		n.logger.InfoContext(ctx, "wechat issue-done notify: skipped by quota/window")
		return nil
	}
	return err
}

func (n *IssueDoneNotifier) isDoneTerminal(ctx context.Context, workspaceID pgtype.UUID, status, statusCategory string) bool {
	if status == issuestatus.Done || statusCategory == issuestatus.Done {
		return true
	}
	if issuestatus.IsBuiltIn(status) {
		return false
	}
	if statusCategory == issuestatus.Cancelled || statusCategory == issuestatus.CategoryClosed {
		return false
	}
	entry, err := n.q.GetIssueStatusEntryByKey(ctx, db.GetIssueStatusEntryByKeyParams{
		WorkspaceID: workspaceID,
		Key:         status,
	})
	if err != nil {
		return false
	}
	return entry.Category == issuestatus.CategoryDone
}

type issueDoneSnapshot struct {
	ID             string  `json:"id"`
	WorkspaceID    string  `json:"workspace_id"`
	Number         int32   `json:"number"`
	Identifier     string  `json:"identifier"`
	Title          string  `json:"title"`
	Status         string  `json:"status"`
	StatusCategory string  `json:"status_category"`
	StatusName     string  `json:"status_name"`
	AssigneeType   *string `json:"assignee_type"`
	AssigneeID     *string `json:"assignee_id"`
	CreatorType    string  `json:"creator_type"`
	CreatorID      string  `json:"creator_id"`
	Revision       int64   `json:"revision"`
}

func parseIssueUpdated(e events.Event) (issueDoneSnapshot, bool, bool) {
	payload, ok := e.Payload.(map[string]any)
	if !ok {
		return issueDoneSnapshot{}, false, false
	}
	statusChanged, _ := payload["status_changed"].(bool)
	raw, ok := payload["issue"]
	if !ok || raw == nil {
		return issueDoneSnapshot{}, false, statusChanged
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return issueDoneSnapshot{}, false, statusChanged
	}
	var issue issueDoneSnapshot
	if err := json.Unmarshal(b, &issue); err != nil {
		return issueDoneSnapshot{}, false, statusChanged
	}
	return issue, issue.ID != "", statusChanged
}

func relatedMemberIDs(issue issueDoneSnapshot) []string {
	ids := make([]string, 0, 2)
	seen := make(map[string]bool, 2)
	add := func(typ, id string) {
		id = strings.TrimSpace(id)
		if typ != "member" || id == "" || seen[id] {
			return
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if issue.AssigneeType != nil && issue.AssigneeID != nil {
		add(*issue.AssigneeType, *issue.AssigneeID)
	}
	add(issue.CreatorType, issue.CreatorID)
	return ids
}

func formatIssueDoneText(issue issueDoneSnapshot) string {
	ident := strings.TrimSpace(issue.Identifier)
	if ident == "" && issue.Number > 0 {
		ident = fmt.Sprintf("#%d", issue.Number)
	}
	if ident == "" {
		ident = "任务"
	}
	statusLabel := strings.TrimSpace(issue.StatusName)
	if statusLabel == "" {
		statusLabel = "已完成"
	}
	var b strings.Builder
	b.WriteString(ident)
	b.WriteString(" ")
	b.WriteString(statusLabel)
	if title := strings.TrimSpace(issue.Title); title != "" {
		b.WriteString("\n")
		b.WriteString(title)
	}
	return b.String()
}
