package dingtalk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Issue-done P2P notify is a separate subscriber from Outbound. Chat reply
// delivery (EventChatDone / EventTaskFailed / EventTaskCancelled) stays on
// Outbound so this path cannot change the originating-conversation round trip.
//
// protocol.EventIssueStatusChanged is the workspace STATUS CATALOG moving
// (create / edit / archive / reorder). An issue reaching a terminal status is
// protocol.EventIssueUpdated with status_changed=true — the same signal the
// inbox, activity log, and plugin bridge already use.

const (
	issueDoneNotifyTimeout      = 10 * time.Second
	issueDoneFileTimeout        = 60 * time.Second
	issueDoneCommentWindow      = 32
	issueDoneSummaryByteBudget  = 8000
	issueDoneStatusChangesGroup = "status_changes"
	issueDoneMaxFileBytes       = 10 << 20
	issueDoneMaxFiles           = 3
	issueDonePartialNote        = "部分附件未转发"
)

// issueDoneQueries is the slice of generated queries this subscriber needs.
// *db.Queries satisfies it.
type issueDoneQueries interface {
	FindChannelBindingForMember(ctx context.Context, arg db.FindChannelBindingForMemberParams) (db.ChannelUserBinding, error)
	GetChannelInstallation(ctx context.Context, arg db.GetChannelInstallationParams) (db.ChannelInstallation, error)
	ListCommentsForIssue(ctx context.Context, arg db.ListCommentsForIssueParams) ([]db.Comment, error)
	ListAttachmentsByIssueAndComment(ctx context.Context, arg db.ListAttachmentsByIssueAndCommentParams) ([]db.Attachment, error)
	GetNotificationPreference(ctx context.Context, arg db.GetNotificationPreferenceParams) (db.NotificationPreference, error)
	GetIssueStatusEntryByKey(ctx context.Context, arg db.GetIssueStatusEntryByKeyParams) (db.IssueStatus, error)
}

// issueDoneObjectStore is the slice of storage.Storage this path needs.
type issueDoneObjectStore interface {
	KeyFromURL(rawURL string) string
	GetReader(ctx context.Context, key string) (io.ReadCloser, error)
}

var _ issueDoneQueries = (*db.Queries)(nil)

// IssueDoneNotifier pushes a 1:1 DingTalk markdown message when an issue
// reaches a done-category terminal status. Recipients are workspace members
// related to the issue (assignee first, then creator) who have an active
// DingTalk binding. Unbound members, agents, and cancelled issues are skipped.
type IssueDoneNotifier struct {
	q       issueDoneQueries
	decrypt Decrypter
	client  *Client
	store   issueDoneObjectStore
	logger  *slog.Logger
	// spawn runs the delivery. A field rather than a bare `go` so tests can
	// run it inline and observe the result deterministically.
	spawn func(func())
	// seen is a process-local at-most-once set keyed by issue + revision +
	// status + recipient. EventIssueUpdated is published on the in-process
	// bus of the replica that performed the write, so this covers replay of
	// the same event (including two overlapping goroutines) without a new
	// table. A later done after reopen has a new revision and notifies again.
	seen sync.Map
}

// NewIssueDoneNotifier builds the subscriber. decrypt is the same AppSecret
// opener the chat outbound path uses; a nil Client constructs a default.
// store may be nil: markdown still sends, attachments are skipped.
func NewIssueDoneNotifier(q issueDoneQueries, decrypt Decrypter, client *Client, store issueDoneObjectStore, logger *slog.Logger) *IssueDoneNotifier {
	if logger == nil {
		logger = slog.Default()
	}
	if client == nil {
		client = NewClient(nil, "")
	}
	return &IssueDoneNotifier{
		q:       q,
		decrypt: decrypt,
		client:  client,
		store:   store,
		logger:  logger,
		spawn:   func(f func()) { go f() },
	}
}

// Register subscribes to issue field updates. Chat-task terminal events are
// deliberately not listed here.
func (n *IssueDoneNotifier) Register(bus *events.Bus) {
	bus.Subscribe(protocol.EventIssueUpdated, n.handleIssueUpdated)
}

func (n *IssueDoneNotifier) handleIssueUpdated(e events.Event) {
	n.spawn(func() {
		ctx, cancel := context.WithTimeout(context.Background(), issueDoneNotifyTimeout)
		defer cancel()
		if err := n.processIssueUpdated(ctx, e); err != nil {
			n.logger.WarnContext(ctx, "dingtalk issue-done notify: delivery failed",
				"error", err, "workspace_id", e.WorkspaceID)
		}
	})
}

func (n *IssueDoneNotifier) processIssueUpdated(ctx context.Context, e events.Event) error {
	issue, ok, statusChanged := parseIssueUpdated(e)
	if !ok || !statusChanged {
		return nil
	}
	wsID, err := util.ParseUUID(firstNonEmpty(issue.WorkspaceID, e.WorkspaceID))
	if err != nil || !wsID.Valid {
		return nil
	}
	if !n.isDoneTerminal(ctx, wsID, issue.Status, issue.StatusCategory) {
		return nil
	}

	result := n.latestAgentResult(ctx, issue)
	body := formatIssueDoneMarkdown(issue, result.summary)
	if result.partial {
		body = appendIssueDonePartialNote(body)
	}
	if strings.TrimSpace(body) == "" {
		return nil
	}

	var sendErr error
	for _, memberID := range relatedMemberIDs(issue) {
		if err := n.notifyMember(ctx, wsID, issue, memberID, body, result.files); err != nil {
			sendErr = err
		}
	}
	return sendErr
}

func (n *IssueDoneNotifier) notifyMember(ctx context.Context, wsID pgtype.UUID, issue issueDoneSnapshot, memberID, body string, files []db.Attachment) error {
	userID, err := util.ParseUUID(memberID)
	if err != nil || !userID.Valid {
		return nil
	}
	if n.statusChangesMuted(ctx, wsID, userID) {
		return nil
	}
	binding, err := n.q.FindChannelBindingForMember(ctx, db.FindChannelBindingForMemberParams{
		WorkspaceID:   wsID,
		MulticaUserID: userID,
		ChannelType:   string(TypeDingTalk),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("lookup dingtalk member binding: %w", err)
	}
	if binding.ChannelUserID == "" {
		return nil
	}

	key := issueDoneDedupeKey(issue.ID, issue.Revision, issue.Status, memberID)
	if !n.claim(key) {
		return nil
	}

	inst, err := n.q.GetChannelInstallation(ctx, db.GetChannelInstallationParams{
		ID: binding.InstallationID, ChannelType: string(TypeDingTalk),
	})
	if err != nil {
		n.unclaim(key)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("load dingtalk installation: %w", err)
	}
	if inst.Status != "active" {
		n.unclaim(key)
		return nil
	}
	creds, err := decodeCredentials(inst.Config, n.decrypt)
	if err != nil {
		n.unclaim(key)
		return fmt.Errorf("decode dingtalk credentials: %w", err)
	}
	s := &sender{client: n.client, robotCode: creds.RobotCode, appKey: creds.AppKey, appSecret: creds.AppSecret}
	target := sendTarget{ConversationType: convTypeP2P, StaffID: binding.ChannelUserID}
	if _, err := s.send(ctx, target, body); err != nil {
		n.unclaim(key)
		return fmt.Errorf("post dingtalk issue-done notify: %w", err)
	}
	if len(files) > 0 {
		fileCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), issueDoneFileTimeout)
		defer cancel()
		n.forwardIssueDoneImages(fileCtx, s, target, files)
		n.forwardIssueDoneFiles(fileCtx, s, target, files)
	}
	return nil
}

func (n *IssueDoneNotifier) isDoneTerminal(ctx context.Context, workspaceID pgtype.UUID, status, statusCategory string) bool {
	if status == issuestatus.Done || statusCategory == issuestatus.Done {
		return true
	}
	if issuestatus.IsBuiltIn(status) {
		return false
	}
	if statusCategory == issuestatus.Cancelled {
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

func (n *IssueDoneNotifier) latestAgentResult(ctx context.Context, issue issueDoneSnapshot) issueDoneResult {
	issueID, err := util.ParseUUID(issue.ID)
	if err != nil || !issueID.Valid {
		return issueDoneResult{}
	}
	wsID, err := util.ParseUUID(issue.WorkspaceID)
	if err != nil || !wsID.Valid {
		return issueDoneResult{}
	}
	comments, err := n.q.ListCommentsForIssue(ctx, db.ListCommentsForIssueParams{
		IssueID:     issueID,
		WorkspaceID: wsID,
		Limit:       issueDoneCommentWindow,
	})
	if err != nil {
		n.logger.WarnContext(ctx, "dingtalk issue-done notify: comments unavailable",
			"error", err, "issue_id", issue.ID)
		return issueDoneResult{}
	}
	comment, ok := latestAgentComment(comments)
	if !ok {
		return issueDoneResult{}
	}
	out := issueDoneResult{summary: strings.TrimSpace(comment.Content)}
	if n.store == nil || !comment.ID.Valid {
		return out
	}
	rows, err := n.q.ListAttachmentsByIssueAndComment(ctx, db.ListAttachmentsByIssueAndCommentParams{
		WorkspaceID: wsID,
		IssueID:     issueID,
		CommentID:   comment.ID,
	})
	if err != nil {
		n.logger.WarnContext(ctx, "dingtalk issue-done notify: attachments unavailable",
			"error", err, "issue_id", issue.ID)
		return out
	}
	send, skipped, partial := planIssueDoneAttachments(rows)
	out.files = send
	out.partial = partial
	for _, row := range skipped {
		n.logger.WarnContext(ctx, "dingtalk issue-done notify: attachment not forwarded",
			"filename", row.Filename,
			"content_type", row.ContentType,
			"size_bytes", row.SizeBytes)
	}
	return out
}

func (n *IssueDoneNotifier) statusChangesMuted(ctx context.Context, workspaceID, userID pgtype.UUID) bool {
	pref, err := n.q.GetNotificationPreference(ctx, db.GetNotificationPreferenceParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
	})
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			n.logger.WarnContext(ctx, "dingtalk issue-done notify: preference lookup failed",
				"error", err)
		}
		return false
	}
	return notificationGroupMuted(pref.Preferences, issueDoneStatusChangesGroup)
}

func (n *IssueDoneNotifier) claim(key string) bool {
	_, loaded := n.seen.LoadOrStore(key, struct{}{})
	return !loaded
}

func (n *IssueDoneNotifier) unclaim(key string) {
	n.seen.Delete(key)
}

// issueDoneSnapshot is the subset of the issue:updated payload this path reads.
// JSON round-trip keeps it independent of handler.IssueResponse (that import
// would cycle: handler already imports this package).
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

// relatedMemberIDs returns distinct member user ids in notify order: assignee
// first, then creator. Agents and squads are not DingTalk-bindable recipients.
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

func latestAgentComment(comments []db.Comment) (db.Comment, bool) {
	for i := len(comments) - 1; i >= 0; i-- {
		c := comments[i]
		if c.DeletedAt.Valid || c.AuthorType != "agent" {
			continue
		}
		return c, true
	}
	return db.Comment{}, false
}

func latestAgentCommentContent(comments []db.Comment) string {
	c, ok := latestAgentComment(comments)
	if !ok {
		return ""
	}
	return strings.TrimSpace(c.Content)
}

func formatIssueDoneMarkdown(issue issueDoneSnapshot, summary string) string {
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
	b.WriteString("# ")
	b.WriteString(ident)
	b.WriteString(" ")
	b.WriteString(statusLabel)
	b.WriteString("\n\n")
	if title := strings.TrimSpace(issue.Title); title != "" {
		b.WriteString("**标题：** ")
		b.WriteString(title)
		b.WriteString("\n\n")
	}
	b.WriteString("**状态：** ")
	switch {
	case issue.StatusName != "" && issue.Status != "" && issue.StatusName != issue.Status:
		b.WriteString(issue.StatusName)
		b.WriteString(" (`")
		b.WriteString(issue.Status)
		b.WriteString("`)")
	case issue.Status != "":
		b.WriteString(issue.Status)
	default:
		b.WriteString(statusLabel)
	}
	if summary = strings.TrimSpace(summary); summary != "" {
		b.WriteString("\n\n**结果摘要：**\n\n")
		b.WriteString(truncateIssueDoneSummary(summary))
	}
	return b.String()
}

func truncateIssueDoneSummary(summary string) string {
	const suffix = "\n..."
	if len(summary) <= issueDoneSummaryByteBudget {
		return summary
	}
	limit := issueDoneSummaryByteBudget - len(suffix)
	if limit <= 0 {
		return suffix
	}
	for limit > 0 && !utf8.RuneStart(summary[limit]) {
		limit--
	}
	return summary[:limit] + suffix
}

func notificationGroupMuted(raw []byte, group string) bool {
	if len(raw) == 0 {
		return false
	}
	var prefs map[string]string
	if err := json.Unmarshal(raw, &prefs); err != nil {
		return false
	}
	return prefs[group] == "muted"
}

func issueDoneDedupeKey(issueID string, revision int64, status, memberID string) string {
	return fmt.Sprintf("%s:%d:%s:%s", issueID, revision, status, memberID)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
