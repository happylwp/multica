package wechat

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 1×1 PNG. Magic bytes are enough for http.DetectContentType.
var png1x1 = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
	0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
	0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb4, 0x00, 0x00, 0x00,
	0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
}

func TestEmbedQRImageFetchesAndEncodesPNG(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png1x1)
	}))
	defer srv.Close()

	got, err := embedQRImage(context.Background(), srv.Client(), srv.URL+"/qr.png?key=SESSION")
	if err != nil {
		t.Fatal(err)
	}
	want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png1x1)
	if got != want {
		t.Fatalf("got %s", got)
	}
}

func TestEmbedQRImagePassesThroughDataURL(t *testing.T) {
	raw := "data:image/png;base64,abc"
	got, err := embedQRImage(context.Background(), nil, raw)
	if err != nil || got != raw {
		t.Fatalf("got %q err=%v", got, err)
	}
}

func TestEmbedQRImageRejectsNonImageAndKeepsURLOutOfError(t *testing.T) {
	secret := "session-secret-key"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>denied</html>"))
	}))
	defer srv.Close()

	raw := srv.URL + "/qr?token=" + secret
	_, err := embedQRImage(context.Background(), srv.Client(), raw)
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), raw) {
		t.Fatalf("url leaked in error: %v", err)
	}
}

func TestEmbedQRImageHTTPStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "gone", http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := embedQRImage(context.Background(), srv.Client(), srv.URL+"/missing")
	if err == nil {
		t.Fatal("expected error")
	}
	if qrImageFetchKind(err) != "http_status" {
		t.Fatalf("kind = %s err=%v", qrImageFetchKind(err), err)
	}
}

func TestQRImageURLLogMetaStripsQuery(t *testing.T) {
	raw := "https://liteapp.weixin.qq.com/path/qr?key=SESSION_SECRET&sig=abc"
	prefix, n := qrImageURLLogMeta(raw)
	if n != len(raw) {
		t.Fatalf("len = %d want %d", n, len(raw))
	}
	if strings.Contains(prefix, "SESSION_SECRET") || strings.Contains(prefix, "sig=") {
		t.Fatalf("query leaked: %s", prefix)
	}
	if prefix != "https://liteapp.weixin.qq.com/path/qr" {
		t.Fatalf("prefix = %s", prefix)
	}
}
