package wechat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/util"
)

const pollRetryDelay = 2 * time.Second

// wechatChannel is ONE installation's getupdates long-polling loop.
type wechatChannel struct {
	botID   string
	instID  pgtype.UUID
	api     *iLinkClient
	handler channel.InboundHandler
	quota   *QuotaStore
	persist configPersister
	encrypt Encrypter
	md      bool
	cursor  string
	logger  *slog.Logger
}

func (c *wechatChannel) Type() channel.Type { return TypeWechat }

func (c *wechatChannel) Capabilities() channel.Capability {
	// Official iLink does not support quote-reply. Rich text is unverified
	// so we declare text only; markdown is an installation opt-in that still
	// goes out as a single text body.
	return channel.CapText
}

func (c *wechatChannel) Disconnect(ctx context.Context) error {
	if c.api == nil {
		return nil
	}
	if err := c.api.NotifyStop(ctx); err != nil && ctx.Err() == nil {
		c.logger.WarnContext(ctx, "wechat: notifystop failed", "error", err)
	}
	return nil
}

func (c *wechatChannel) Send(ctx context.Context, out channel.OutboundMessage) (channel.SendResult, error) {
	return newSender(c.api, c.quota, c.persist, c.encrypt, c.instID, c.md, c.logger).Send(ctx, out)
}

func (c *wechatChannel) Connect(ctx context.Context) error {
	if c.handler == nil {
		return errors.New("wechat: inbound handler not configured")
	}
	if err := c.api.NotifyStart(ctx); err != nil {
		if errors.Is(err, ErrSessionExpired) {
			return err
		}
		c.logger.WarnContext(ctx, "wechat: notifystart failed", "error", err)
	}
	for {
		env, err := c.api.GetUpdates(ctx, c.cursor)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(err, ErrSessionExpired) {
				c.logger.WarnContext(ctx, "wechat: getupdates session expired — re-scan required")
				return err
			}
			c.logger.WarnContext(ctx, "wechat: getupdates failed", "error", err)
			if !sleepCtx(ctx, pollRetryDelay) {
				return nil
			}
			return fmt.Errorf("wechat: getupdates: %w", err)
		}
		if env.GetUpdatesBuf != "" {
			c.cursor = env.GetUpdatesBuf
		}
		for _, m := range env.Msgs {
			if err := c.dispatch(ctx, m); err != nil {
				if ctx.Err() != nil {
					return nil
				}
				return err
			}
		}
		if err := persistSessions(ctx, c.persist, c.encrypt, c.instID, c.quota, c.cursor); err != nil {
			c.logger.WarnContext(ctx, "wechat: persist cursor/quota failed", "error", err)
		}
	}
}

func (c *wechatChannel) dispatch(ctx context.Context, m WeixinMessage) error {
	if m.ContextToken != "" && m.FromUserID != "" && m.MessageType != messageTypeBot {
		at := time.Now()
		if m.CreateTimeMS > 0 {
			at = time.UnixMilli(m.CreateTimeMS)
		}
		c.quota.NoteInbound(util.UUIDToString(c.instID), m.FromUserID, m.ContextToken, at)
	}
	msg, ok := inboundFromMessage(m, c.botID)
	if !ok {
		return nil
	}
	if msg.Type != channel.MsgTypeText {
		if msg.Source.ChatType == channel.ChatTypeP2P || msg.AddressedToBot {
			c.notifyUnsupported(ctx, m)
		}
		return nil
	}
	if msg.Text == "" {
		return nil
	}
	return c.handler(ctx, msg)
}

func (c *wechatChannel) notifyUnsupported(ctx context.Context, m WeixinMessage) {
	_, err := newSender(c.api, c.quota, c.persist, c.encrypt, c.instID, false, c.logger).
		Send(ctx, channel.OutboundMessage{ChatID: m.FromUserID, Text: msgUnsupportedType})
	if err != nil {
		c.logger.WarnContext(ctx, "wechat: unsupported-type notice failed", "error", err)
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// ChannelDeps are the shared dependencies the WeChat Factory closes over.
type ChannelDeps struct {
	Decrypt    Decrypter
	Encrypt    Encrypter
	Quota      *QuotaStore
	Persist    configPersister
	Logger     *slog.Logger
	APIBase    string
	HTTPClient *http.Client
}

// RegisterWechat registers the per-installation Factory so the
// engine.Supervisor builds + supervises one polling loop per active WeChat
// installation. Same contract as lark.RegisterFeishu / telegram.RegisterTelegram.
func RegisterWechat(reg *channel.Registry, deps ChannelDeps) {
	reg.Register(TypeWechat, newWechatFactory(deps))
}

func newWechatFactory(deps ChannelDeps) channel.Factory {
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	if deps.Quota == nil {
		deps.Quota = NewQuotaStore()
	}
	return func(cfg channel.Config) (channel.Channel, error) {
		var ic installConfig
		if err := json.Unmarshal(cfg.Raw, &ic); err != nil {
			return nil, fmt.Errorf("wechat: decode installation config: %w", err)
		}
		token, err := decryptToken(ic.BotTokenEncrypted, deps.Decrypt)
		if err != nil {
			return nil, fmt.Errorf("wechat: decrypt bot token: %w", err)
		}
		if token == "" {
			return nil, errors.New("wechat: installation has no bot token")
		}
		hydrateQuota(deps.Quota, util.UUIDToString(cfg.ID), ic, deps.Decrypt)
		return &wechatChannel{
			botID:   ic.AppID,
			instID:  cfg.ID,
			api:     newILinkClient(firstNonEmpty(ic.BaseURL, deps.APIBase), token, deps.HTTPClient),
			handler: cfg.Handler,
			quota:   deps.Quota,
			persist: deps.Persist,
			encrypt: deps.Encrypt,
			md:      ic.SupportMarkdown,
			cursor:  ic.GetUpdatesBuf,
			logger:  logger,
		}, nil
	}
}
