package wechat

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestGetQRCodeStatusPollCapReturnsWait(t *testing.T) {
	orig := qrPollCapForTest
	qrPollCapForTest = 80 * time.Millisecond
	t.Cleanup(func() { qrPollCapForTest = orig })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": QRStatusScanned})
	}))
	defer srv.Close()

	c := newILinkClient(srv.URL, "", srv.Client())
	t0 := time.Now()
	st, err := c.GetQRCodeStatus(context.Background(), "live-key", "")
	elapsed := time.Since(t0)
	if err != nil || st.Status != QRStatusWait {
		t.Fatalf("poll cap must be wait: st=%+v err=%v", st, err)
	}
	if elapsed < 60*time.Millisecond || elapsed > 500*time.Millisecond {
		t.Fatalf("poll cap elapsed %s, want ~80ms", elapsed)
	}
}

func TestGetQRCodeStatusCapClosedConnReturnsWait(t *testing.T) {
	orig := qrPollCapForTest
	qrPollCapForTest = 40 * time.Millisecond
	t.Cleanup(func() { qrPollCapForTest = orig })

	c := newILinkClient("http://qr.example", "", &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			<-req.Context().Done()
			return nil, errors.New("use of closed network connection")
		}),
	})
	st, err := c.GetQRCodeStatus(context.Background(), "live-key", "")
	if err != nil || st.Status != QRStatusWait {
		t.Fatalf("cap + closed conn must be wait: st=%+v err=%v", st, err)
	}
}

func TestGetQRCodeStatusLiveCtxClosedConnIsError(t *testing.T) {
	c := newILinkClient("http://qr.example", "", &http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("use of closed network connection")
		}),
	})
	st, err := c.GetQRCodeStatus(context.Background(), "live-key", "")
	if err == nil || st.Status == QRStatusWait {
		t.Fatalf("live ctx closed conn must stay an error: st=%+v err=%v", st, err)
	}
}

func TestBuildClientVersion(t *testing.T) {
	if got := buildClientVersion("2.4.9"); got != "132105" {
		t.Fatalf("2.4.9 = %s want 132105", got)
	}
	if got := buildClientVersion("1.0.11"); got != "65547" {
		t.Fatalf("1.0.11 = %s want 65547", got)
	}
}

func assertNodeStyleHeaders(t *testing.T, h http.Header) {
	t.Helper()
	want := map[string]string{
		"User-Agent":              "node",
		"Accept":                  "*/*",
		"Accept-Language":         "*",
		"Sec-Fetch-Mode":          "cors",
		"Accept-Encoding":         "gzip, deflate",
		"iLink-App-ClientVersion": "132105",
	}
	for k, v := range want {
		if h.Get(k) != v {
			t.Fatalf("%s = %q want %q", k, h.Get(k), v)
		}
	}
}

func TestCommonHeadersMatchOfficialNode(t *testing.T) {
	var post, get http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/get_bot_qrcode") && r.Method == http.MethodPost:
			post = r.Header.Clone()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ret": 0, "qrcode": "qr-key", "qrcode_img_content": "https://img.example/qr",
			})
		case strings.HasSuffix(r.URL.Path, "/get_qrcode_status") && r.Method == http.MethodGet:
			get = r.Header.Clone()
			_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0, "status": QRStatusWait})
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := newILinkClient(srv.URL, "", srv.Client())
	if _, err := c.GetBotQRCode(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetQRCodeStatus(context.Background(), "qr-key", ""); err != nil {
		t.Fatal(err)
	}
	if post == nil || get == nil {
		t.Fatal("did not capture POST and GET headers")
	}
	assertNodeStyleHeaders(t, post)
	assertNodeStyleHeaders(t, get)
	if post.Get("AuthorizationType") != "ilink_bot_token" {
		t.Fatal("POST missing AuthorizationType")
	}
	if post.Get("Content-Type") != "application/json" {
		t.Fatal("POST missing Content-Type")
	}
	if post.Get("X-WECHAT-UIN") == "" {
		t.Fatal("POST missing X-WECHAT-UIN")
	}
	if get.Get("AuthorizationType") != "" || get.Get("X-WECHAT-UIN") != "" || get.Get("Content-Type") != "" {
		t.Fatalf("GET must not send POST-only headers: %+v", get)
	}
}

func TestReadResponseBodyGzip(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(`{"ret":0}`)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	resp := &http.Response{
		Header: http.Header{"Content-Encoding": []string{"gzip"}},
		Body:   io.NopCloser(bytes.NewReader(buf.Bytes())),
	}
	got, err := readResponseBody(resp, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"ret":0}` {
		t.Fatalf("got %q", got)
	}
}

func TestDoDecodesGzipJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		if _, err := zw.Write([]byte(`{"ret":0,"get_updates_buf":"gz-cursor","msgs":[]}`)); err != nil {
			t.Fatal(err)
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(buf.Bytes())
	}))
	defer srv.Close()
	c := newILinkClient(srv.URL, "tok", srv.Client())
	env, err := c.GetUpdates(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if env.GetUpdatesBuf != "gz-cursor" {
		t.Fatalf("env = %+v", env)
	}
}

func TestLiveGetBotQRCodeRet0(t *testing.T) {
	if os.Getenv("WECHAT_ILINK_LIVE") != "1" {
		t.Skip("set WECHAT_ILINK_LIVE=1 to hit ilinkai.weixin.qq.com")
	}
	c := newILinkClient("", "", nil)
	qr, err := c.GetBotQRCode(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if qr.Key == "" {
		t.Fatal("empty qrcode key")
	}
	prefix := qr.Key
	if len(prefix) > 8 {
		prefix = prefix[:8]
	}
	t.Logf("get_bot_qrcode ret=0 key_prefix=%s len=%d", prefix, len(qr.Key))
}
