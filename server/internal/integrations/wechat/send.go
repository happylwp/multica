package wechat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/util"
)

// sender posts text through iLink under the official quota. Shared by
// Channel.Send, the EventChatDone outbound path, the engine replier, and
// issue-done notify so they cannot accidentally spend past the 10/24h cap.
type sender struct {
	api     *iLinkClient
	quota   *QuotaStore
	persist configPersister
	encrypt Encrypter
	instID  pgtype.UUID
	md      bool
	logger  *slog.Logger
}

type configPersister interface {
	UpdateConfig(ctx context.Context, id pgtype.UUID, fn func(*installConfig) error) error
}

func newSender(api *iLinkClient, quota *QuotaStore, persist configPersister, encrypt Encrypter, instID pgtype.UUID, supportMarkdown bool, logger *slog.Logger) *sender {
	if logger == nil {
		logger = slog.Default()
	}
	if quota == nil {
		quota = NewQuotaStore()
	}
	return &sender{
		api: api, quota: quota, persist: persist, encrypt: encrypt,
		instID: instID, md: supportMarkdown, logger: logger,
	}
}

func (s *sender) instKey() string { return util.UUIDToString(s.instID) }

// Send delivers out.Text to out.ChatID (the WeChat user / group id) after
// markdown degradation, chunking, and quota reservation. Window miss or a
// fully spent quota is a non-retryable error — nothing is written.
func (s *sender) Send(ctx context.Context, out channel.OutboundMessage) (channel.SendResult, error) {
	if s.api == nil {
		return channel.SendResult{}, errors.New("wechat: api client not configured")
	}
	if out.ChatID == "" {
		return channel.SendResult{}, errors.New("wechat: missing chat id")
	}
	token, ok := s.quota.Token(s.instKey(), out.ChatID)
	if !ok || token == "" {
		return channel.SendResult{}, ErrWindowExpired
	}

	body := renderOutbound(out.Text, s.md)
	chunks := chunkText(body, maxMessageRunes)
	if len(chunks) == 0 {
		return channel.SendResult{}, nil
	}

	now := time.Now()
	reserved, err := s.quota.TryReserve(s.instKey(), out.ChatID, now, len(chunks))
	switch {
	case errors.Is(err, ErrWindowExpired):
		s.logger.InfoContext(ctx, "wechat: send refused, 24h session window expired")
		return channel.SendResult{}, err
	case reserved == 0 && errors.Is(err, ErrQuotaExceeded):
		s.logger.InfoContext(ctx, "wechat: send refused, 10-message quota spent",
			"wanted", len(chunks))
		return channel.SendResult{}, err
	case errors.Is(err, ErrQuotaExceeded) && reserved > 0:
		var dropped int
		chunks, dropped = fitChunks(chunks, reserved, maxMessageRunes)
		s.logger.InfoContext(ctx, "wechat: send degraded, quota short of chunks",
			"wanted", reserved+dropped, "sent", reserved, "dropped", dropped)
	case err != nil:
		return channel.SendResult{}, err
	}

	var lastID string
	var ids []string
	for _, chunk := range chunks {
		if err := s.api.SendText(ctx, out.ChatID, token, chunk); err != nil {
			return channel.SendResult{MessageID: lastID, MessageIDs: ids}, fmt.Errorf("wechat: sendmessage: %w", err)
		}
		lastID = out.ChatID
		ids = append(ids, lastID)
	}
	if persistErr := persistSessions(ctx, s.persist, s.encrypt, s.instID, s.quota, ""); persistErr != nil {
		s.logger.WarnContext(ctx, "wechat: persist quota snapshot failed", "error", persistErr)
	}
	return channel.SendResult{MessageID: lastID, MessageIDs: ids}, nil
}
