package wechat

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestEncodeQRImageBuildsPNGFromLandingURL(t *testing.T) {
	raw := "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=SESSION_SECRET&bot_type=3"
	got, err := encodeQRImage(raw)
	if err != nil {
		t.Fatal(err)
	}
	const prefix = "data:image/png;base64,"
	if !strings.HasPrefix(got, prefix) {
		t.Fatalf("got %s", got[:min(len(got), 40)])
	}
	bin, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(got, prefix))
	if err != nil {
		t.Fatal(err)
	}
	if len(bin) < 8 || string(bin[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("not a PNG (%d bytes)", len(bin))
	}
	other, err := encodeQRImage("https://liteapp.weixin.qq.com/q/other")
	if err != nil || other == got {
		t.Fatalf("different landing URLs must encode differently: err=%v", err)
	}
}

func TestEncodeQRImageDoesNotFetchAndKeepsURLOutOfError(t *testing.T) {
	secret := "session-secret-key"
	got, err := encodeQRImage("javascript:alert(" + secret + ")")
	if err == nil || got != "" {
		t.Fatalf("expected scheme error, got %q err=%v", got, err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("url leaked in error: %v", err)
	}
	if _, err := encodeQRImage(""); err == nil {
		t.Fatal("empty url must fail")
	}
}

func TestEncodeQRImagePassesThroughDataURL(t *testing.T) {
	raw := "data:image/png;base64,abc"
	got, err := encodeQRImage(raw)
	if err != nil || got != raw {
		t.Fatalf("got %q err=%v", got, err)
	}
}

func TestQRImageURLLogMetaStripsQuery(t *testing.T) {
	raw := "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=SESSION_SECRET&bot_type=3"
	prefix, n := qrImageURLLogMeta(raw)
	if n != len(raw) {
		t.Fatalf("len = %d want %d", n, len(raw))
	}
	if strings.Contains(prefix, "SESSION_SECRET") || strings.Contains(prefix, "qrcode=") {
		t.Fatalf("query leaked: %s", prefix)
	}
	if prefix != "https://liteapp.weixin.qq.com/q/7GiQu1" {
		t.Fatalf("prefix = %s", prefix)
	}
}
