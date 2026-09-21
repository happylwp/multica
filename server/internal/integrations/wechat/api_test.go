package wechat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGetUpdatesUnpacksMessagesAndCursor(t *testing.T) {
	var seenCursor string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ilink/bot/getupdates" || r.Method != http.MethodPost {
			t.Fatalf("path/method = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("AuthorizationType") != "ilink_bot_token" {
			t.Fatal("missing AuthorizationType")
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			t.Fatal("missing bearer")
		}
		if r.Header.Get("Authorization") != "Bearer secret-token" {
			t.Fatal("token leaked or wrong")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		seenCursor, _ = body["get_updates_buf"].(string)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ret":             0,
			"get_updates_buf": "cursor-2",
			"msgs": []map[string]any{{
				"message_id":    7,
				"seq":           3,
				"from_user_id":  "wxid_alice",
				"message_type":  1,
				"context_token": "ctx-1",
				"item_list":     []map[string]any{{"type": 1, "text_item": map[string]any{"text": "你好"}}},
			}},
		})
	}))
	defer srv.Close()

	c := newILinkClient(srv.URL, "secret-token", srv.Client())
	env, err := c.GetUpdates(context.Background(), "cursor-1")
	if err != nil {
		t.Fatal(err)
	}
	if seenCursor != "cursor-1" || env.GetUpdatesBuf != "cursor-2" || len(env.Msgs) != 1 {
		t.Fatalf("cursor/msgs = %q %q n=%d", seenCursor, env.GetUpdatesBuf, len(env.Msgs))
	}
	if env.Msgs[0].FromUserID != "wxid_alice" || env.Msgs[0].ContextToken != "ctx-1" {
		t.Fatalf("msg = %+v", env.Msgs[0])
	}
}

func TestGetUpdatesSessionExpired(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 1, "errcode": -14, "errmsg": "stale"})
	}))
	defer srv.Close()
	c := newILinkClient(srv.URL, "tok", srv.Client())
	_, err := c.GetUpdates(context.Background(), "")
	if !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), "tok") || strings.Contains(err.Error(), "stale") && strings.Contains(err.Error(), "Bearer") {
		t.Fatalf("error leaked secret: %v", err)
	}
}

func TestSendTextShape(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ilink/bot/sendmessage" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0})
	}))
	defer srv.Close()
	c := newILinkClient(srv.URL, "tok", srv.Client())
	if err := c.SendText(context.Background(), "wxid_bob", "ctx-9", "hello"); err != nil {
		t.Fatal(err)
	}
	msg := got["msg"].(map[string]any)
	if msg["to_user_id"] != "wxid_bob" || msg["context_token"] != "ctx-9" {
		t.Fatalf("msg = %#v", msg)
	}
	if msg["from_user_id"] != "" || msg["message_type"] != float64(2) || msg["message_state"] != float64(2) {
		t.Fatalf("required send fields missing: %#v", msg)
	}
	if msg["client_id"] == "" {
		t.Fatal("client_id must be unique and non-empty")
	}
}

func TestQRLoginStateMachine(t *testing.T) {
	status := QRStatusWait
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/get_bot_qrcode") && r.Method == http.MethodPost:
			if r.URL.Query().Get("bot_type") != "3" {
				t.Fatal("bot_type")
			}
			body, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(body), "local_token_list") {
				t.Fatalf("body = %s", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"qrcode": "qr-key", "qrcode_img_content": "https://img.example/qr",
			})
		case strings.HasSuffix(r.URL.Path, "/get_qrcode_status") && r.Method == http.MethodGet:
			if r.URL.Query().Get("qrcode") != "qr-key" {
				t.Fatalf("qrcode query = %s", r.URL.RawQuery)
			}
			out := map[string]any{"status": status}
			if status == QRStatusConfirmed {
				out["bot_token"] = "bot-tok"
				out["ilink_bot_id"] = "bot-1"
				out["ilink_user_id"] = "wxid_me"
				out["nickname"] = "Ada"
			}
			_ = json.NewEncoder(w).Encode(out)
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := newILinkClient(srv.URL, "", srv.Client())

	qr, err := c.GetBotQRCode(context.Background())
	if err != nil || qr.Key != "qr-key" || qr.ImageURL == "" {
		t.Fatalf("qr = %+v err=%v", qr, err)
	}

	st, err := c.GetQRCodeStatus(context.Background(), qr.Key, "")
	if err != nil || st.Status != QRStatusWait {
		t.Fatalf("wait = %+v err=%v", st, err)
	}
	status = QRStatusScanned
	st, err = c.GetQRCodeStatus(context.Background(), qr.Key, "")
	if err != nil || st.Status != QRStatusScanned {
		t.Fatalf("scaned = %+v err=%v", st, err)
	}
	status = QRStatusConfirmed
	st, err = c.GetQRCodeStatus(context.Background(), qr.Key, "")
	if err != nil || st.Status != QRStatusConfirmed || st.BotID != "bot-1" || st.UserID != "wxid_me" {
		t.Fatalf("confirmed = %+v err=%v", st, err)
	}
}

func TestRequestErrorOmitsURL(t *testing.T) {
	c := newILinkClient("http://127.0.0.1:1", "super-secret-token", &http.Client{})
	_, err := c.GetUpdates(context.Background(), "")
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), "super-secret-token") {
		t.Fatalf("token leaked in error: %v", err)
	}
}

func TestDoRejectsNon2xxEvenWithZeroRet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0, "msgs": []any{}})
	}))
	defer srv.Close()
	c := newILinkClient(srv.URL, "tok", srv.Client())
	_, err := c.GetUpdates(context.Background(), "")
	if err == nil || !strings.Contains(err.Error(), "http 401") {
		t.Fatalf("err = %v", err)
	}
}

func TestDoRejectsNonZeroRet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 1, "errcode": 42, "errmsg": "nope"})
	}))
	defer srv.Close()
	c := newILinkClient(srv.URL, "tok", srv.Client())
	_, err := c.GetUpdates(context.Background(), "")
	var ae *apiError
	if !errors.As(err, &ae) || ae.Ret != 1 || ae.ErrCode != 42 {
		t.Fatalf("err = %v", err)
	}
}

func TestGetQRCodeStatusDoesNotTreatUpstreamErrorAsWait(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 1, "errcode": 1001})
	}))
	defer srv.Close()
	c := newILinkClient(srv.URL, "", srv.Client())
	st, err := c.GetQRCodeStatus(context.Background(), "qr", "")
	if err == nil || st.Status == QRStatusWait {
		t.Fatalf("upstream error must not become wait: st=%+v err=%v", st, err)
	}
	var ae *apiError
	if !errors.As(err, &ae) || ae.ErrCode != 1001 {
		t.Fatalf("err = %v", err)
	}
}

func TestGetBotQRCodeRejectsHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"ret":0,"qrcode":"should-not-use"}`))
	}))
	defer srv.Close()
	c := newILinkClient(srv.URL, "", srv.Client())
	qr, err := c.GetBotQRCode(context.Background())
	if err == nil || qr.Key != "" || !strings.Contains(err.Error(), "http 502") {
		t.Fatalf("qr=%+v err=%v", qr, err)
	}
}

func TestNewILinkClientQRStatusTimeout(t *testing.T) {
	c := newILinkClient("", "", &http.Client{Timeout: 15 * time.Second})
	if c.qrStatus == nil || c.qrStatus.Timeout < 60*time.Second {
		t.Fatalf("qr status timeout = %v", c.qrStatus)
	}
	if c.client.Timeout != 15*time.Second {
		t.Fatalf("short client mutated: %s", c.client.Timeout)
	}
}

func TestGetQRCodeStatusTimeoutReturnsWait(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": QRStatusScanned})
	}))
	defer srv.Close()
	c := newILinkClient(srv.URL, "", srv.Client())
	c.qrStatus.Timeout = 30 * time.Millisecond
	st, err := c.GetQRCodeStatus(context.Background(), "live-key", "")
	if err != nil || st.Status != QRStatusWait {
		t.Fatalf("timeout must be wait: st=%+v err=%v", st, err)
	}
}
