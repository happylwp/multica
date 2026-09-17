package dingtalk

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type fakeIssueDoneQueries struct {
	binding        db.ChannelUserBinding
	bindingErr     error
	bindings       map[string]db.ChannelUserBinding
	installation   db.ChannelInstallation
	installErr     error
	comments       []db.Comment
	commentsErr    error
	attachments    []db.Attachment
	attachmentsErr error
	pref           db.NotificationPreference
	prefErr        error
	statusEntry    db.IssueStatus
	statusEntryErr error

	bindingCalls     int
	installCalls     int
	commentCalls     int
	attachmentCalls  int
	prefCalls        int
	statusCalls      int
	lastBindingID    string
	lastAttachmentID pgtype.UUID
}

func (q *fakeIssueDoneQueries) FindChannelBindingForMember(_ context.Context, arg db.FindChannelBindingForMemberParams) (db.ChannelUserBinding, error) {
	q.bindingCalls++
	q.lastBindingID = util.UUIDToString(arg.MulticaUserID)
	if q.bindings != nil {
		if b, ok := q.bindings[q.lastBindingID]; ok {
			return b, nil
		}
		return db.ChannelUserBinding{}, pgx.ErrNoRows
	}
	if q.bindingErr != nil {
		return db.ChannelUserBinding{}, q.bindingErr
	}
	return q.binding, nil
}

func (q *fakeIssueDoneQueries) GetChannelInstallation(_ context.Context, _ db.GetChannelInstallationParams) (db.ChannelInstallation, error) {
	q.installCalls++
	if q.installErr != nil {
		return db.ChannelInstallation{}, q.installErr
	}
	return q.installation, nil
}

func (q *fakeIssueDoneQueries) ListCommentsForIssue(_ context.Context, _ db.ListCommentsForIssueParams) ([]db.Comment, error) {
	q.commentCalls++
	if q.commentsErr != nil {
		return nil, q.commentsErr
	}
	return q.comments, nil
}

func (q *fakeIssueDoneQueries) ListAttachmentsByIssueAndComment(_ context.Context, arg db.ListAttachmentsByIssueAndCommentParams) ([]db.Attachment, error) {
	q.attachmentCalls++
	q.lastAttachmentID = arg.CommentID
	if q.attachmentsErr != nil {
		return nil, q.attachmentsErr
	}
	return q.attachments, nil
}

func (q *fakeIssueDoneQueries) GetNotificationPreference(_ context.Context, _ db.GetNotificationPreferenceParams) (db.NotificationPreference, error) {
	q.prefCalls++
	if q.prefErr != nil {
		return db.NotificationPreference{}, q.prefErr
	}
	return q.pref, nil
}

func (q *fakeIssueDoneQueries) GetIssueStatusEntryByKey(_ context.Context, _ db.GetIssueStatusEntryByKeyParams) (db.IssueStatus, error) {
	q.statusCalls++
	if q.statusEntryErr != nil {
		return db.IssueStatus{}, q.statusEntryErr
	}
	return q.statusEntry, nil
}

func testIssueDoneInstallationConfig(t *testing.T) []byte {
	t.Helper()
	config, err := json.Marshal(installConfig{
		AppID:              "app",
		RobotCode:          "robot",
		AppSecretEncrypted: base64.StdEncoding.EncodeToString([]byte("secret")),
	})
	if err != nil {
		t.Fatal(err)
	}
	return config
}

func testIssueDoneNotifier(t *testing.T, q *fakeIssueDoneQueries, srv *dingtalkSendServer) *IssueDoneNotifier {
	t.Helper()
	return testIssueDoneNotifierStore(t, q, srv, nil)
}

func testIssueDoneNotifierStore(t *testing.T, q *fakeIssueDoneQueries, srv *dingtalkSendServer, store issueDoneObjectStore) *IssueDoneNotifier {
	t.Helper()
	n := NewIssueDoneNotifier(q, nil, NewClient(nil, srv.srv.URL), store, nil)
	n.spawn = func(f func()) { f() }
	return n
}

func ptrText(s string) *string { return &s }

func doneIssuePayload(issue map[string]any) map[string]any {
	return map[string]any{"issue": issue, "status_changed": true}
}

func baseDoneIssue(t *testing.T, assigneeID, creatorID pgtype.UUID) map[string]any {
	t.Helper()
	return map[string]any{
		"id":              util.UUIDToString(sessionUUID(10)),
		"workspace_id":    util.UUIDToString(sessionUUID(11)),
		"number":          45,
		"identifier":      "MARO-45",
		"title":           "实现终态钉钉推送",
		"status":          issuestatus.Done,
		"status_category": issuestatus.Done,
		"assignee_type":   "member",
		"assignee_id":     util.UUIDToString(assigneeID),
		"creator_type":    "member",
		"creator_id":      util.UUIDToString(creatorID),
		"revision":        int64(7),
	}
}

func TestIssueDoneNotifierSendsP2POnDone(t *testing.T) {
	d := newDingtalkSendServer(t)
	member := sessionUUID(1)
	q := &fakeIssueDoneQueries{
		binding: db.ChannelUserBinding{
			InstallationID: sessionUUID(20),
			ChannelUserID:  "staff-assignee",
		},
		installation: db.ChannelInstallation{
			ID: sessionUUID(20), Status: "active", Config: testIssueDoneInstallationConfig(t),
		},
		prefErr: pgx.ErrNoRows,
		comments: []db.Comment{
			{AuthorType: "member", Content: "please ship it"},
			{AuthorType: "agent", Content: "已合并到 feature 分支，本地测试通过。"},
		},
	}
	n := testIssueDoneNotifier(t, q, d)
	event := events.Event{
		Type:        protocol.EventIssueUpdated,
		WorkspaceID: util.UUIDToString(sessionUUID(11)),
		Payload:     doneIssuePayload(baseDoneIssue(t, member, member)),
	}
	if err := n.processIssueUpdated(context.Background(), event); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.lastPath != pathSendP2P {
		t.Fatalf("path = %q, want P2P batchSend", d.lastPath)
	}
	if d.sendCalls != 1 {
		t.Fatalf("sends=%d, want 1", d.sendCalls)
	}
	if ids, ok := d.lastBody["userIds"].([]any); !ok || len(ids) != 1 || ids[0] != "staff-assignee" {
		t.Fatalf("userIds = %v", d.lastBody["userIds"])
	}
	text := decodeMsgParamText(t, d.lastBody)
	for _, want := range []string{"MARO-45", "实现终态钉钉推送", "done", "已合并到 feature 分支，本地测试通过。"} {
		if !strings.Contains(text, want) {
			t.Fatalf("markdown missing %q:\n%s", want, text)
		}
	}
}

func TestIssueDoneNotifierSkipsNonTerminalStatus(t *testing.T) {
	d := newDingtalkSendServer(t)
	q := &fakeIssueDoneQueries{prefErr: pgx.ErrNoRows}
	n := testIssueDoneNotifier(t, q, d)
	issue := baseDoneIssue(t, sessionUUID(1), sessionUUID(2))
	issue["status"] = issuestatus.InProgress
	issue["status_category"] = issuestatus.InProgress
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(issue),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 0 || q.bindingCalls != 0 {
		t.Fatalf("non-terminal status must not look up bindings or send: sends=%d bindings=%d", d.sendCalls, q.bindingCalls)
	}
}

func TestIssueDoneNotifierSkipsCancelled(t *testing.T) {
	d := newDingtalkSendServer(t)
	q := &fakeIssueDoneQueries{prefErr: pgx.ErrNoRows}
	n := testIssueDoneNotifier(t, q, d)
	issue := baseDoneIssue(t, sessionUUID(1), sessionUUID(2))
	issue["status"] = issuestatus.Cancelled
	issue["status_category"] = issuestatus.Cancelled
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(issue),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 0 {
		t.Fatalf("cancelled must not notify, sends=%d", d.sendCalls)
	}
}

func TestIssueDoneNotifierSkipsWhenStatusDidNotChange(t *testing.T) {
	d := newDingtalkSendServer(t)
	q := &fakeIssueDoneQueries{prefErr: pgx.ErrNoRows}
	n := testIssueDoneNotifier(t, q, d)
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type: protocol.EventIssueUpdated,
		Payload: map[string]any{
			"issue":          baseDoneIssue(t, sessionUUID(1), sessionUUID(2)),
			"status_changed": false,
			"title_changed":  true,
		},
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 0 {
		t.Fatalf("status_changed=false must not notify, sends=%d", d.sendCalls)
	}
}

func TestIssueDoneNotifierSkipsUnboundMembers(t *testing.T) {
	d := newDingtalkSendServer(t)
	q := &fakeIssueDoneQueries{bindingErr: pgx.ErrNoRows, prefErr: pgx.ErrNoRows}
	n := testIssueDoneNotifier(t, q, d)
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(2))),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 0 {
		t.Fatalf("unbound members must not notify, sends=%d", d.sendCalls)
	}
	if q.installCalls != 0 {
		t.Fatalf("unbound path must not load installation, calls=%d", q.installCalls)
	}
}

func TestIssueDoneNotifierDedupesReplay(t *testing.T) {
	d := newDingtalkSendServer(t)
	assignee := sessionUUID(1)
	q := &fakeIssueDoneQueries{
		binding: db.ChannelUserBinding{InstallationID: sessionUUID(20), ChannelUserID: "staff-1"},
		installation: db.ChannelInstallation{
			ID: sessionUUID(20), Status: "active", Config: testIssueDoneInstallationConfig(t),
		},
		prefErr: pgx.ErrNoRows,
	}
	n := testIssueDoneNotifier(t, q, d)
	event := events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, assignee, assignee)),
	}
	if err := n.processIssueUpdated(context.Background(), event); err != nil {
		t.Fatalf("first: %v", err)
	}
	if err := n.processIssueUpdated(context.Background(), event); err != nil {
		t.Fatalf("replay: %v", err)
	}
	if d.sendCalls != 1 {
		t.Fatalf("replay must send once, sends=%d", d.sendCalls)
	}
}

func TestIssueDoneNotifierNotifiesAssigneeThenCreator(t *testing.T) {
	d := newDingtalkSendServer(t)
	assignee, creator := sessionUUID(1), sessionUUID(2)
	instID := sessionUUID(20)
	q := &fakeIssueDoneQueries{
		bindings: map[string]db.ChannelUserBinding{
			util.UUIDToString(assignee): {InstallationID: instID, ChannelUserID: "staff-a"},
			util.UUIDToString(creator):  {InstallationID: instID, ChannelUserID: "staff-c"},
		},
		installation: db.ChannelInstallation{
			ID: instID, Status: "active", Config: testIssueDoneInstallationConfig(t),
		},
		prefErr: pgx.ErrNoRows,
	}
	n := testIssueDoneNotifier(t, q, d)
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, assignee, creator)),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 2 {
		t.Fatalf("sends=%d, want assignee then creator", d.sendCalls)
	}
	got := make([]string, 0, 2)
	for _, body := range d.sendBodies {
		ids, _ := body["userIds"].([]any)
		if len(ids) != 1 {
			t.Fatalf("userIds = %v", ids)
		}
		got = append(got, ids[0].(string))
	}
	if got[0] != "staff-a" || got[1] != "staff-c" {
		t.Fatalf("recipient order = %v", got)
	}
}

func TestIssueDoneNotifierReleasesClaimOnSendFailure(t *testing.T) {
	assignee := sessionUUID(1)
	q := &fakeIssueDoneQueries{
		binding: db.ChannelUserBinding{InstallationID: sessionUUID(20), ChannelUserID: "staff-1"},
		installation: db.ChannelInstallation{
			ID: sessionUUID(20), Status: "active", Config: testIssueDoneInstallationConfig(t),
		},
		prefErr: pgx.ErrNoRows,
	}
	n := NewIssueDoneNotifier(q, nil, NewClient(nil, "http://127.0.0.1:1"), nil, nil)
	n.spawn = func(f func()) { f() }
	event := events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, assignee, assignee)),
	}
	if err := n.processIssueUpdated(context.Background(), event); err == nil {
		t.Fatal("expected send failure")
	}
	ok := newDingtalkSendServer(t)
	n.client = NewClient(nil, ok.srv.URL)
	if err := n.processIssueUpdated(context.Background(), event); err != nil {
		t.Fatalf("retry after failure: %v", err)
	}
	if ok.sendCalls != 1 {
		t.Fatalf("retry after failed send must go through, sends=%d", ok.sendCalls)
	}
}

func TestIssueDoneNotifierFallsBackToCreatorWhenAssigneeIsAgent(t *testing.T) {
	d := newDingtalkSendServer(t)
	creator := sessionUUID(2)
	q := &fakeIssueDoneQueries{
		binding: db.ChannelUserBinding{InstallationID: sessionUUID(20), ChannelUserID: "staff-creator"},
		installation: db.ChannelInstallation{
			ID: sessionUUID(20), Status: "active", Config: testIssueDoneInstallationConfig(t),
		},
		prefErr: pgx.ErrNoRows,
	}
	n := testIssueDoneNotifier(t, q, d)
	issue := baseDoneIssue(t, sessionUUID(1), creator)
	issue["assignee_type"] = "agent"
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(issue),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 1 {
		t.Fatalf("sends=%d", d.sendCalls)
	}
	if ids, ok := d.lastBody["userIds"].([]any); !ok || ids[0] != "staff-creator" {
		t.Fatalf("userIds = %v, want creator", d.lastBody["userIds"])
	}
	if q.lastBindingID != util.UUIDToString(creator) {
		t.Fatalf("looked up %s, want creator", q.lastBindingID)
	}
}

func TestIssueDoneNotifierRespectsMutedStatusChanges(t *testing.T) {
	d := newDingtalkSendServer(t)
	q := &fakeIssueDoneQueries{
		binding: db.ChannelUserBinding{InstallationID: sessionUUID(20), ChannelUserID: "staff-1"},
		installation: db.ChannelInstallation{
			ID: sessionUUID(20), Status: "active", Config: testIssueDoneInstallationConfig(t),
		},
		pref: db.NotificationPreference{Preferences: []byte(`{"status_changes":"muted"}`)},
	}
	n := testIssueDoneNotifier(t, q, d)
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 0 {
		t.Fatalf("muted status_changes must not notify, sends=%d", d.sendCalls)
	}
	if q.bindingCalls != 0 {
		t.Fatalf("muted recipient must not look up binding, calls=%d", q.bindingCalls)
	}
}

func TestIssueDoneNotifierCustomDoneCategory(t *testing.T) {
	d := newDingtalkSendServer(t)
	assignee := sessionUUID(1)
	q := &fakeIssueDoneQueries{
		binding: db.ChannelUserBinding{InstallationID: sessionUUID(20), ChannelUserID: "staff-1"},
		installation: db.ChannelInstallation{
			ID: sessionUUID(20), Status: "active", Config: testIssueDoneInstallationConfig(t),
		},
		prefErr:     pgx.ErrNoRows,
		statusEntry: db.IssueStatus{Key: "shipped", Category: issuestatus.CategoryDone, Name: "已上线"},
	}
	n := testIssueDoneNotifier(t, q, d)
	issue := baseDoneIssue(t, assignee, assignee)
	issue["status"] = "shipped"
	issue["status_category"] = ""
	issue["status_name"] = "已上线"
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(issue),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 1 {
		t.Fatalf("custom done-category status must notify, sends=%d", d.sendCalls)
	}
	if q.statusCalls != 1 {
		t.Fatalf("empty status_category must consult catalog, calls=%d", q.statusCalls)
	}
}

func TestIssueDoneNotifierRegisterIgnoresChatEventsAndCatalog(t *testing.T) {
	d := newDingtalkSendServer(t)
	q := &fakeIssueDoneQueries{
		binding: db.ChannelUserBinding{InstallationID: sessionUUID(20), ChannelUserID: "staff-1"},
		installation: db.ChannelInstallation{
			ID: sessionUUID(20), Status: "active", Config: testIssueDoneInstallationConfig(t),
		},
		prefErr: pgx.ErrNoRows,
	}
	n := testIssueDoneNotifier(t, q, d)
	bus := events.New()
	n.Register(bus)
	bus.Publish(events.Event{Type: protocol.EventChatDone, Payload: protocol.ChatDonePayload{Content: "reply"}})
	bus.Publish(events.Event{Type: protocol.EventIssueStatusChanged, Payload: map[string]any{"action": "updated"}})
	if d.sendCalls != 0 || q.bindingCalls != 0 {
		t.Fatalf("chat/catalog events must not notify: sends=%d bindings=%d", d.sendCalls, q.bindingCalls)
	}
	bus.Publish(events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	})
	if d.sendCalls != 1 {
		t.Fatalf("issue:updated done must notify via Register, sends=%d", d.sendCalls)
	}
}

func TestRelatedMemberIDsAssigneeFirstThenCreator(t *testing.T) {
	assignee, creator := "user-a", "user-c"
	ids := relatedMemberIDs(issueDoneSnapshot{
		AssigneeType: ptrText("member"),
		AssigneeID:   &assignee,
		CreatorType:  "member",
		CreatorID:    creator,
	})
	if len(ids) != 2 || ids[0] != assignee || ids[1] != creator {
		t.Fatalf("ids = %v", ids)
	}
	ids = relatedMemberIDs(issueDoneSnapshot{
		AssigneeType: ptrText("agent"),
		AssigneeID:   &assignee,
		CreatorType:  "member",
		CreatorID:    creator,
	})
	if len(ids) != 1 || ids[0] != creator {
		t.Fatalf("agent assignee should fall through to creator, ids=%v", ids)
	}
	ids = relatedMemberIDs(issueDoneSnapshot{
		AssigneeType: ptrText("member"),
		AssigneeID:   &creator,
		CreatorType:  "member",
		CreatorID:    creator,
	})
	if len(ids) != 1 || ids[0] != creator {
		t.Fatalf("duplicate member must collapse, ids=%v", ids)
	}
}

func TestFormatIssueDoneMarkdownIncludesFieldsAndTruncatesSummary(t *testing.T) {
	text := formatIssueDoneMarkdown(issueDoneSnapshot{
		Identifier: "MARO-45",
		Title:      "实现终态钉钉推送",
		Status:     "done",
	}, "agent wrapped it up")
	for _, want := range []string{"# MARO-45 已完成", "**标题：** 实现终态钉钉推送", "**状态：** done", "**结果摘要：**", "agent wrapped it up"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
	long := strings.Repeat("结果", issueDoneSummaryByteBudget)
	got := formatIssueDoneMarkdown(issueDoneSnapshot{Identifier: "X-1", Status: "done"}, long)
	if !strings.HasSuffix(strings.TrimSpace(got), "...") {
		t.Fatalf("long summary must truncate, tail=%q", got[len(got)-20:])
	}
	if len(got) > issueDoneSummaryByteBudget+512 {
		t.Fatalf("formatted body still too large: %d", len(got))
	}
}

func TestLatestAgentCommentContentSkipsDeletedAndPrefersNewest(t *testing.T) {
	deleted := pgtype.Timestamptz{Valid: true}
	got := latestAgentCommentContent([]db.Comment{
		{AuthorType: "agent", Content: "old"},
		{AuthorType: "agent", Content: "deleted later", DeletedAt: deleted},
		{AuthorType: "member", Content: "human"},
		{AuthorType: "agent", Content: "newest"},
	})
	if got != "newest" {
		t.Fatalf("got %q", got)
	}
	if latestAgentCommentContent(nil) != "" {
		t.Fatal("empty comments should yield empty summary")
	}
}

func TestParseIssueUpdatedRequiresStatusChanged(t *testing.T) {
	issue, ok, changed := parseIssueUpdated(events.Event{Payload: doneIssuePayload(map[string]any{
		"id": "issue-1", "status": "done",
	})})
	if !ok || !changed || issue.ID != "issue-1" {
		t.Fatalf("issue=%+v ok=%v changed=%v", issue, ok, changed)
	}
	_, ok, changed = parseIssueUpdated(events.Event{Payload: map[string]any{"issue": map[string]any{"id": "x"}}})
	if !ok || changed {
		t.Fatalf("missing flag: ok=%v changed=%v", ok, changed)
	}
}

func decodeMsgParamText(t *testing.T, body map[string]any) string {
	t.Helper()
	paramRaw, ok := body["msgParam"].(string)
	if !ok {
		t.Fatalf("msgParam = %T", body["msgParam"])
	}
	var param markdownParam
	if err := json.Unmarshal([]byte(paramRaw), &param); err != nil {
		t.Fatalf("decode msgParam: %v", err)
	}
	return param.Text
}

func TestNotificationGroupMuted(t *testing.T) {
	if !notificationGroupMuted([]byte(`{"status_changes":"muted"}`), "status_changes") {
		t.Fatal("muted")
	}
	if notificationGroupMuted([]byte(`{"status_changes":"all"}`), "status_changes") {
		t.Fatal("all is not muted")
	}
	if notificationGroupMuted(nil, "status_changes") {
		t.Fatal("empty prefs are not muted")
	}
	if notificationGroupMuted([]byte(`not-json`), "status_changes") {
		t.Fatal("malformed prefs fail open")
	}
}

func TestIssueDoneNotifierSendFailureDoesNotPanicAndLogsViaReturn(t *testing.T) {
	q := &fakeIssueDoneQueries{
		binding: db.ChannelUserBinding{InstallationID: sessionUUID(20), ChannelUserID: "staff-1"},
		installation: db.ChannelInstallation{
			ID: sessionUUID(20), Status: "active", Config: testIssueDoneInstallationConfig(t),
		},
		prefErr: pgx.ErrNoRows,
	}
	n := NewIssueDoneNotifier(q, nil, NewClient(nil, "http://127.0.0.1:1"), nil, nil)
	n.spawn = func(f func()) { f() }
	err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	})
	if err == nil {
		t.Fatal("expected transport error")
	}
	if !strings.Contains(err.Error(), "post dingtalk issue-done notify") {
		t.Fatalf("error = %v", err)
	}
}

func TestIssueDoneDedupeKeyIncludesRecipient(t *testing.T) {
	a := issueDoneDedupeKey("i", 7, "done", "u1")
	b := issueDoneDedupeKey("i", 7, "done", "u2")
	c := issueDoneDedupeKey("i", 8, "done", "u1")
	if a == b || a == c {
		t.Fatalf("keys collided: %q %q %q", a, b, c)
	}
}

type memIssueDoneStore struct {
	objects map[string][]byte
	err     error
}

func (m *memIssueDoneStore) KeyFromURL(raw string) string {
	const prefix = "/uploads/"
	if i := strings.Index(raw, prefix); i >= 0 {
		return raw[i+len(prefix):]
	}
	return raw
}

func (m *memIssueDoneStore) GetReader(_ context.Context, key string) (io.ReadCloser, error) {
	if m.err != nil {
		return nil, m.err
	}
	data, ok := m.objects[key]
	if !ok {
		return nil, fmt.Errorf("missing %s", key)
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func testIssueDoneFile(id byte, name, contentType, key string, size int64) db.Attachment {
	return db.Attachment{
		ID:          sessionUUID(id),
		Filename:    name,
		ContentType: contentType,
		Url:         "/uploads/" + key,
		SizeBytes:   size,
		CommentID:   sessionUUID(30),
		WorkspaceID: sessionUUID(11),
		IssueID:     sessionUUID(10),
	}
}

func issueDoneFileQueries(t *testing.T, files []db.Attachment) *fakeIssueDoneQueries {
	t.Helper()
	return &fakeIssueDoneQueries{
		binding: db.ChannelUserBinding{InstallationID: sessionUUID(20), ChannelUserID: "staff-1"},
		installation: db.ChannelInstallation{
			ID: sessionUUID(20), Status: "active", Config: testIssueDoneInstallationConfig(t),
		},
		prefErr: pgx.ErrNoRows,
		comments: []db.Comment{{
			ID:         sessionUUID(30),
			AuthorType: "agent",
			Content:    "见附件",
		}},
		attachments: files,
	}
}

func decodeFileParam(t *testing.T, body map[string]any) fileParam {
	t.Helper()
	raw, ok := body["msgParam"].(string)
	if !ok {
		t.Fatalf("msgParam = %T", body["msgParam"])
	}
	var p fileParam
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatalf("decode file msgParam: %v", err)
	}
	return p
}

func TestIssueDoneNotifierForwardsImageAndDocument(t *testing.T) {
	d := newDingtalkSendServer(t)
	png := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 'x'}
	pdf := []byte("%PDF-1.4 mock")
	q := issueDoneFileQueries(t, []db.Attachment{
		testIssueDoneFile(41, "shot.png", "image/png", "img-key", int64(len(png))),
		testIssueDoneFile(42, "notes.pdf", "application/pdf", "pdf-key", int64(len(pdf))),
	})
	store := &memIssueDoneStore{objects: map[string][]byte{"img-key": png, "pdf-key": pdf}}
	n := testIssueDoneNotifierStore(t, q, d, store)
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 3 {
		t.Fatalf("sends=%d, want summary markdown + image markdown + sampleFile", d.sendCalls)
	}
	if d.uploadCalls != 2 {
		t.Fatalf("uploads=%d, want 2", d.uploadCalls)
	}
	if q.attachmentCalls != 1 {
		t.Fatalf("attachment lookups=%d", q.attachmentCalls)
	}
	if d.sendBodies[0]["msgKey"] != msgKeyMarkdown {
		t.Fatalf("first msgKey = %v, want markdown", d.sendBodies[0]["msgKey"])
	}
	text := decodeMsgParamText(t, d.sendBodies[0])
	if strings.Contains(text, issueDonePartialNote) {
		t.Fatalf("eligible files must not add partial note:\n%s", text)
	}
	if strings.Contains(text, "![图片]") {
		t.Fatalf("image markdown must be a follow-up message, not the summary:\n%s", text)
	}
	if d.sendBodies[1]["msgKey"] != msgKeyMarkdown {
		t.Fatalf("image follow-up msgKey = %v, want markdown", d.sendBodies[1]["msgKey"])
	}
	imageText := decodeMsgParamText(t, d.sendBodies[1])
	if imageText != "![图片](@media-1)" {
		t.Fatalf("image markdown = %q", imageText)
	}
	if d.sendBodies[2]["msgKey"] != msgKeyFile {
		t.Fatalf("document msgKey = %v, want sampleFile", d.sendBodies[2]["msgKey"])
	}
	doc := decodeFileParam(t, d.sendBodies[2])
	if doc.FileName != "notes.pdf" || doc.FileType != "pdf" || doc.MediaID != "@media-1" {
		t.Fatalf("document param = %+v", doc)
	}
}

func TestIssueDoneNotifierNoAttachmentsSkipsUpload(t *testing.T) {
	d := newDingtalkSendServer(t)
	q := issueDoneFileQueries(t, nil)
	n := testIssueDoneNotifierStore(t, q, d, &memIssueDoneStore{objects: map[string][]byte{}})
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 1 || d.uploadCalls != 0 {
		t.Fatalf("sends=%d uploads=%d, want markdown only", d.sendCalls, d.uploadCalls)
	}
}

func TestIssueDoneNotifierCapsAtThreeFiles(t *testing.T) {
	d := newDingtalkSendServer(t)
	var files []db.Attachment
	objects := map[string][]byte{}
	for i := byte(1); i <= 4; i++ {
		key := fmt.Sprintf("f-%d", i)
		objects[key] = []byte{i}
		files = append(files, testIssueDoneFile(40+i, fmt.Sprintf("a%d.png", i), "image/png", key, 1))
	}
	q := issueDoneFileQueries(t, files)
	n := testIssueDoneNotifierStore(t, q, d, &memIssueDoneStore{objects: objects})
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 4 {
		t.Fatalf("sends=%d, want summary markdown + 3 image markdowns", d.sendCalls)
	}
	if d.uploadCalls != 3 {
		t.Fatalf("uploads=%d, want 3", d.uploadCalls)
	}
	text := decodeMsgParamText(t, d.sendBodies[0])
	if !strings.Contains(text, issueDonePartialNote) {
		t.Fatalf("over-count must note partial forward:\n%s", text)
	}
	for i := 1; i <= 3; i++ {
		if d.sendBodies[i]["msgKey"] != msgKeyMarkdown {
			t.Fatalf("follow-up %d msgKey = %v, want markdown", i, d.sendBodies[i]["msgKey"])
		}
		if got := decodeMsgParamText(t, d.sendBodies[i]); got != "![图片](@media-1)" {
			t.Fatalf("follow-up %d = %q", i, got)
		}
	}
}

func TestIssueDoneNotifierSkipsOversizeFile(t *testing.T) {
	d := newDingtalkSendServer(t)
	q := issueDoneFileQueries(t, []db.Attachment{
		testIssueDoneFile(41, "huge.pdf", "application/pdf", "huge", issueDoneMaxFileBytes+1),
	})
	n := testIssueDoneNotifierStore(t, q, d, &memIssueDoneStore{objects: map[string][]byte{"huge": []byte("x")}})
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	}); err != nil {
		t.Fatalf("processIssueUpdated: %v", err)
	}
	if d.sendCalls != 1 || d.uploadCalls != 0 {
		t.Fatalf("oversize must not upload: sends=%d uploads=%d", d.sendCalls, d.uploadCalls)
	}
	text := decodeMsgParamText(t, d.sendBodies[0])
	if !strings.Contains(text, issueDonePartialNote) {
		t.Fatalf("oversize must note partial forward:\n%s", text)
	}
}

func TestIssueDoneNotifierFileFailureDoesNotFailNotify(t *testing.T) {
	d := newDingtalkSendServer(t)
	d.failFileSend = true
	data := []byte("hello pdf")
	q := issueDoneFileQueries(t, []db.Attachment{
		testIssueDoneFile(41, "notes.pdf", "application/pdf", "pdf-key", int64(len(data))),
	})
	n := testIssueDoneNotifierStore(t, q, d, &memIssueDoneStore{objects: map[string][]byte{"pdf-key": data}})
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	}); err != nil {
		t.Fatalf("file send failure must not fail notify: %v", err)
	}
	if d.sendBodies[0]["msgKey"] != msgKeyMarkdown {
		t.Fatalf("markdown must still send, msgKey=%v", d.sendBodies[0]["msgKey"])
	}
	if d.uploadCalls != 1 {
		t.Fatalf("uploads=%d, want 1", d.uploadCalls)
	}
}

func TestIssueDoneNotifierUploadPermissionFailureDoesNotFailNotify(t *testing.T) {
	d := newDingtalkSendServer(t)
	d.failUpload = true
	data := []byte("hello pdf")
	q := issueDoneFileQueries(t, []db.Attachment{
		testIssueDoneFile(41, "notes.pdf", "application/pdf", "pdf-key", int64(len(data))),
	})
	n := testIssueDoneNotifierStore(t, q, d, &memIssueDoneStore{objects: map[string][]byte{"pdf-key": data}})
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	}); err != nil {
		t.Fatalf("upload permission failure must not fail notify: %v", err)
	}
	if d.sendCalls != 1 || d.uploadCalls != 1 {
		t.Fatalf("sends=%d uploads=%d", d.sendCalls, d.uploadCalls)
	}
}

func TestIssueDoneNotifierReadFailureDoesNotFailNotify(t *testing.T) {
	d := newDingtalkSendServer(t)
	q := issueDoneFileQueries(t, []db.Attachment{
		testIssueDoneFile(41, "notes.pdf", "application/pdf", "pdf-key", 4),
	})
	n := testIssueDoneNotifierStore(t, q, d, &memIssueDoneStore{err: errors.New("disk missing")})
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	}); err != nil {
		t.Fatalf("read failure must not fail notify: %v", err)
	}
	if d.sendCalls != 1 || d.uploadCalls != 0 {
		t.Fatalf("sends=%d uploads=%d", d.sendCalls, d.uploadCalls)
	}
}

func TestIssueDoneNotifierUnsupportedFormatWarnsAndSkips(t *testing.T) {
	d := newDingtalkSendServer(t)
	q := issueDoneFileQueries(t, []db.Attachment{
		testIssueDoneFile(41, "deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "ppt-key", 12),
	})
	var logs bytes.Buffer
	n := testIssueDoneNotifierStore(t, q, d, &memIssueDoneStore{objects: map[string][]byte{"ppt-key": []byte("pptx-bytes")}})
	n.logger = slog.New(slog.NewTextHandler(&logs, nil))
	if err := n.processIssueUpdated(context.Background(), events.Event{
		Type:    protocol.EventIssueUpdated,
		Payload: doneIssuePayload(baseDoneIssue(t, sessionUUID(1), sessionUUID(1))),
	}); err != nil {
		t.Fatalf("unsupported format must not fail notify: %v", err)
	}
	if d.sendCalls != 1 || d.uploadCalls != 0 {
		t.Fatalf("unsupported must stay on summary text: sends=%d uploads=%d", d.sendCalls, d.uploadCalls)
	}
	if d.sendBodies[0]["msgKey"] != msgKeyMarkdown {
		t.Fatalf("msgKey = %v", d.sendBodies[0]["msgKey"])
	}
	text := decodeMsgParamText(t, d.sendBodies[0])
	if !strings.Contains(text, issueDonePartialNote) {
		t.Fatalf("unsupported must note partial forward:\n%s", text)
	}
	if !strings.Contains(logs.String(), "attachment not forwarded") {
		t.Fatalf("expected warn log, got %q", logs.String())
	}
}
