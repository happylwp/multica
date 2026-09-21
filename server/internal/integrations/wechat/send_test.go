package wechat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/util"
)

func TestSendRespectsWindowAndQuota(t *testing.T) {
	var sends int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/sendmessage") {
			sends++
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0})
	}))
	defer srv.Close()

	quota := NewQuotaStore()
	inst := wechatTestUUID(1)
	api := newILinkClient(srv.URL, "tok", srv.Client())
	s := newSender(api, quota, nil, nil, inst, false, testLogger())
	ctx := context.Background()
	out := channel.OutboundMessage{ChatID: "wxid_a", Text: "hi"}

	_, err := s.Send(ctx, out)
	if !errors.Is(err, ErrWindowExpired) || sends != 0 {
		t.Fatalf("no inbound: err=%v sends=%d", err, sends)
	}

	now := time.Now()
	quota.NoteInbound(s.instKey(), "wxid_a", "ctx", now)
	if _, err := s.Send(ctx, out); err != nil || sends != 1 {
		t.Fatalf("first send: err=%v sends=%d", err, sends)
	}

	for i := 0; i < MaxOutboundPerWindow-1; i++ {
		if _, err := s.Send(ctx, out); err != nil {
			t.Fatalf("send %d: %v", i+2, err)
		}
	}
	if sends != MaxOutboundPerWindow {
		t.Fatalf("sends = %d", sends)
	}
	_, err = s.Send(ctx, out)
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("11th send err = %v", err)
	}
	if sends != MaxOutboundPerWindow {
		t.Fatalf("quota must not write the 11th message, sends=%d", sends)
	}
}

func TestSendDegradesWhenChunksExceedRemaining(t *testing.T) {
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var env map[string]any
		_ = json.NewDecoder(r.Body).Decode(&env)
		msg := env["msg"].(map[string]any)
		items := msg["item_list"].([]any)
		text := items[0].(map[string]any)["text_item"].(map[string]any)["text"].(string)
		bodies = append(bodies, text)
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0})
	}))
	defer srv.Close()

	quota := NewQuotaStore()
	inst := wechatTestUUID(2)
	key := util.UUIDToString(inst)
	quota.NoteInbound(key, "u", "ctx", time.Now())
	_, _ = quota.TryReserve(key, "u", time.Now(), MaxOutboundPerWindow-1)

	long := strings.Repeat("段落\n", 3000)
	s := newSender(newILinkClient(srv.URL, "tok", srv.Client()), quota, nil, nil, inst, false, testLogger())
	_, err := s.Send(context.Background(), channel.OutboundMessage{ChatID: "u", Text: long})
	if err != nil && !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("err = %v", err)
	}
	if len(bodies) != 1 {
		t.Fatalf("expected one degraded send, got %d", len(bodies))
	}
}
