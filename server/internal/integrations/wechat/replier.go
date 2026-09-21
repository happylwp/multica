package wechat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	msgAgentOffline     = "⚠️ 智能体当前离线。消息已收到，上线后会继续处理。"
	msgAgentArchived    = "⚠️ 该智能体已归档，无法回复。请联系工作区管理员。"
	msgUnsupportedType  = "抱歉，暂时无法处理这类消息，请发送文字。"
	msgBindingGroupHint = "请先在与我的私聊中发送消息，再绑定 Multica 账号。"
	msgFreshPending     = "✅ 已准备新会话。下一条消息将不带历史上下文。"
	msgChatStarted      = "✅ 已开始新的 Multica 会话。下一条消息会进入该会话。"
	msgIssueUsage       = "请带上标题。用法：\n\n/issue <标题>\n[描述]（可选）"
	msgIssueNotMember   = "你不是该 Multica 工作区的成员，无法创建议题。请先让管理员邀请你。"
	msgIssueDisabled    = "这个微信通道尚未连接到 Multica（或已断开）。请让工作区管理员重新绑定。"
)

type bindingMinter interface {
	Mint(ctx context.Context, workspaceID, installationID pgtype.UUID, wechatUserID string) (BindingToken, error)
}

// OutboundReplier implements engine.OutboundReplier for WeChat.
type OutboundReplier struct {
	binding     bindingMinter
	decrypt     Decrypter
	encrypt     Encrypter
	quota       *QuotaStore
	persist     configPersister
	appURL      string
	bindingPath string
	apiBase     string
	client      *http.Client
	logger      *slog.Logger
}

// OutboundReplierConfig configures the replier.
type OutboundReplierConfig struct {
	Binding     bindingMinter
	Decrypt     Decrypter
	Encrypt     Encrypter
	Quota       *QuotaStore
	Persist     configPersister
	AppURL      string
	BindingPath string
	APIBase     string
	HTTPClient  *http.Client
	Logger      *slog.Logger
}

var _ engine.OutboundReplier = (*OutboundReplier)(nil)

// NewOutboundReplier builds the replier.
func NewOutboundReplier(cfg OutboundReplierConfig) *OutboundReplier {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	if cfg.Quota == nil {
		cfg.Quota = NewQuotaStore()
	}
	bindingPath := cfg.BindingPath
	if bindingPath == "" {
		bindingPath = "/wechat/bind"
	}
	if !strings.HasPrefix(bindingPath, "/") {
		bindingPath = "/" + bindingPath
	}
	return &OutboundReplier{
		binding:     cfg.Binding,
		decrypt:     cfg.Decrypt,
		encrypt:     cfg.Encrypt,
		quota:       cfg.Quota,
		persist:     cfg.Persist,
		appURL:      strings.TrimRight(cfg.AppURL, "/"),
		bindingPath: bindingPath,
		apiBase:     cfg.APIBase,
		client:      cfg.HTTPClient,
		logger:      logger,
	}
}

// Reply routes each outcome to its user-visible message. Errors are logged,
// not propagated: the replier runs detached from the inbound ACK path.
func (r *OutboundReplier) Reply(ctx context.Context, inst engine.ResolvedInstallation, msg channel.InboundMessage, res engine.Result) {
	switch res.Outcome {
	case engine.OutcomeNeedsBinding:
		if err := r.sendBindingPrompt(ctx, inst, msg, res); err != nil {
			r.logger.WarnContext(ctx, "wechat replier: binding prompt failed",
				"installation_id", util.UUIDToString(inst.ID), "error", err)
		}
	case engine.OutcomeAgentOffline:
		_ = r.post(ctx, inst, msg, msgAgentOffline)
	case engine.OutcomeAgentArchived:
		_ = r.post(ctx, inst, msg, msgAgentArchived)
	case engine.OutcomeFreshPending:
		_ = r.post(ctx, inst, msg, msgFreshPending)
	case engine.OutcomeChatStarted:
		_ = r.post(ctx, inst, msg, msgChatStarted)
	case engine.OutcomeIssueUsage:
		_ = r.post(ctx, inst, msg, msgIssueUsage)
	case engine.OutcomeIngested:
		if res.IssueID.Valid {
			text := issueCreatedText(res)
			if res.IssueDuplicate {
				text = issueDuplicateText(res)
			}
			_ = r.post(ctx, inst, msg, text)
		}
	case engine.OutcomeDropped:
		if text := droppedReplyText(res, msg); text != "" {
			_ = r.post(ctx, inst, msg, text)
		}
	}
}

func (r *OutboundReplier) sendBindingPrompt(ctx context.Context, inst engine.ResolvedInstallation, msg channel.InboundMessage, res engine.Result) error {
	if msg.Source.ChatType == channel.ChatTypeGroup {
		return r.post(ctx, inst, msg, msgBindingGroupHint)
	}
	sender := res.Sender
	if sender == "" {
		sender = msg.Source.SenderID
	}
	if sender == "" {
		return errors.New("missing sender id")
	}
	if r.binding == nil {
		return errors.New("binding service not configured")
	}
	if r.appURL == "" {
		return errors.New("app url not configured")
	}
	token, err := r.binding.Mint(ctx, inst.WorkspaceID, inst.ID, sender)
	if err != nil {
		return fmt.Errorf("mint binding token: %w", err)
	}
	bindURL := r.appURL + r.bindingPath + "?token=" + url.QueryEscape(token.Raw)
	text := "👋 要开始对话，请把微信账号绑定到 Multica：\n" + bindURL + "\n（链接 15 分钟内有效）"
	return r.post(ctx, inst, msg, text)
}

func (r *OutboundReplier) post(ctx context.Context, inst engine.ResolvedInstallation, msg channel.InboundMessage, text string) error {
	row, ok := inst.Platform.(db.ChannelInstallation)
	if !ok {
		return errors.New("installation platform row unavailable")
	}
	creds, err := decodeCredentials(row.Config, r.decrypt)
	if err != nil {
		return fmt.Errorf("decode credentials: %w", err)
	}
	api := newILinkClient(firstNonEmpty(creds.BaseURL, r.apiBase), creds.BotToken, r.client)
	_, err = newSender(api, r.quota, r.persist, r.encrypt, inst.ID, creds.SupportMarkdown, r.logger).
		Send(ctx, channel.OutboundMessage{ChatID: msg.Source.ChatID, Text: text})
	return err
}

func issueCreatedText(res engine.Result) string {
	id := issueResultIdentifier(res)
	title := strings.TrimSpace(res.IssueTitle)
	if title == "" {
		return "✅ 已创建 " + id
	}
	return "✅ 已创建 " + id + " — " + title
}

func issueDuplicateText(res engine.Result) string {
	id := issueResultIdentifier(res)
	title := strings.TrimSpace(res.IssueTitle)
	if title == "" {
		return "⚠️ 未创建 — 已有进行中的议题 " + id
	}
	return "⚠️ 未创建 — 已有进行中的议题 " + id + "：" + title
}

func issueResultIdentifier(res engine.Result) string {
	if res.IssueIdentifier != "" {
		return res.IssueIdentifier
	}
	if res.IssueNumber > 0 {
		return fmt.Sprintf("#%d", res.IssueNumber)
	}
	return util.UUIDToString(res.IssueID)
}

func isAddressedIssueCommand(msg channel.InboundMessage) bool {
	if !msg.AddressedToBot {
		return false
	}
	source := msg.CommandText
	if source == "" {
		source = msg.Text
	}
	_, ok := engine.ParseIssueCommand(source)
	return ok
}

func droppedReplyText(res engine.Result, msg channel.InboundMessage) string {
	if !isAddressedIssueCommand(msg) {
		return ""
	}
	switch res.DropReason {
	case engine.DropReasonNonWorkspaceMember:
		return msgIssueNotMember
	case engine.DropReasonRevokedInstallation:
		return msgIssueDisabled
	default:
		return ""
	}
}
