package wechat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
)

func TestChannelConnectDispatchesGetUpdates(t *testing.T) {
	var polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/notifystart"), strings.HasSuffix(r.URL.Path, "/notifystop"):
			_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0})
		case strings.HasSuffix(r.URL.Path, "/getupdates"):
			n := polls.Add(1)
			if n == 1 {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"ret": 0, "get_updates_buf": "c2",
					"msgs": []map[string]any{{
						"message_id": 1, "from_user_id": "u1", "message_type": 1,
						"context_token": "ctx",
						"item_list":     []map[string]any{{"type": 1, "text_item": map[string]any{"text": "ping"}}},
					}},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0, "msgs": []any{}, "get_updates_buf": "c2"})
		default:
			t.Fatalf("unexpected %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	var got channel.InboundMessage
	done := make(chan struct{})
	ch := &wechatChannel{
		botID:  "bot",
		instID: wechatTestUUID(1),
		api:    newILinkClient(srv.URL, "tok", srv.Client()),
		quota:  NewQuotaStore(),
		logger: testLogger(),
		handler: func(ctx context.Context, msg channel.InboundMessage) error {
			got = msg
			close(done)
			return nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errc := make(chan error, 1)
	go func() { errc <- ch.Connect(ctx) }()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for inbound")
	}
	cancel()
	select {
	case <-errc:
	case <-time.After(2 * time.Second):
		t.Fatal("connect did not return")
	}
	if got.Text != "ping" || got.Source.SenderID != "u1" {
		t.Fatalf("got = %+v", got)
	}
	if !ch.quota.WindowValid(ch.instKeyForTest(), "u1", time.Now()) {
		t.Fatal("inbound must open the 24h window")
	}
}

func (c *wechatChannel) instKeyForTest() string { return c.quotaKey() }

func (c *wechatChannel) quotaKey() string {
	return newSender(nil, c.quota, nil, nil, c.instID, false, testLogger()).instKey()
}

func TestFactoryRejectsEmptyToken(t *testing.T) {
	f := newWechatFactory(ChannelDeps{Logger: testLogger(), Quota: NewQuotaStore()})
	_, err := f(channel.Config{Raw: []byte(`{"app_id":"b","bot_token_encrypted":""}`)})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestRegisterWechat(t *testing.T) {
	reg := channel.NewRegistry()
	RegisterWechat(reg, ChannelDeps{Logger: testLogger(), Quota: NewQuotaStore()})
	if _, ok := reg.Lookup(TypeWechat); !ok {
		t.Fatal("wechat factory not registered")
	}
}
