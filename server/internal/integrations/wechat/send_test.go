package wechat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

func TestSendConcurrentReplyAndIssueDoneKeepsLiveTokenAndQuota(t *testing.T) {
	var (
		mu     sync.Mutex
		tokens []string
		sends  int
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/sendmessage") {
			_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0})
			return
		}
		var env map[string]any
		if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
			t.Error(err)
			return
		}
		msg := env["msg"].(map[string]any)
		tok, _ := msg["context_token"].(string)
		mu.Lock()
		tokens = append(tokens, tok)
		sends++
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0})
	}))
	defer srv.Close()

	quota := NewQuotaStore()
	inst := wechatTestUUID(3)
	key := util.UUIDToString(inst)
	user := "wxid_a"
	now := time.Now()
	staleBudget := SessionBudget{LastInbound: now.Add(-time.Minute)}
	quota.Hydrate(key, user, "stale-token", staleBudget)

	// Inbound refreshes the token; persist has not run yet (Connect order).
	quota.NoteInbound(key, user, "fresh-token", now)

	ctx := context.Background()
	reply := newSender(newILinkClient(srv.URL, "tok", srv.Client()), quota, nil, nil, inst, false, testLogger())
	issueDone := newSender(newILinkClient(srv.URL, "tok", srv.Client()), quota, nil, nil, inst, false, testLogger())
	out := channel.OutboundMessage{ChatID: user, Text: "x"}

	var wg sync.WaitGroup
	var admMu sync.Mutex
	admitted := 0
	run := func(s *sender, n int) {
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				// Stale hydrate racing like the old outbound Send path.
				quota.Hydrate(key, user, "stale-token", staleBudget)
				_, err := s.Send(ctx, out)
				if err == nil {
					admMu.Lock()
					admitted++
					admMu.Unlock()
				}
			}()
		}
	}
	run(reply, 8)
	run(issueDone, 8)
	wg.Wait()

	if admitted != MaxOutboundPerWindow {
		t.Fatalf("admitted %d, want %d", admitted, MaxOutboundPerWindow)
	}
	mu.Lock()
	defer mu.Unlock()
	if sends != MaxOutboundPerWindow {
		t.Fatalf("wire sends = %d", sends)
	}
	for _, tok := range tokens {
		if tok != "fresh-token" {
			t.Fatalf("send used %q, want fresh-token", tok)
		}
	}
	got, ok := quota.Token(key, user)
	if !ok || got != "fresh-token" {
		t.Fatalf("store token = %q ok=%v", got, ok)
	}
	if quota.Remaining(key, user, time.Now()) != 0 {
		t.Fatalf("remaining = %d", quota.Remaining(key, user, time.Now()))
	}
}
