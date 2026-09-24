package wechat

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type recordingTransport struct {
	called atomic.Bool
	next   http.RoundTripper
}

func (r *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r.called.Store(true)
	if r.next != nil {
		return r.next.RoundTrip(req)
	}
	return http.DefaultTransport.RoundTrip(req)
}

func TestUTLSTransportHTTPUsesFallback(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0, "ok": true})
	}))
	defer srv.Close()

	rec := &recordingTransport{next: http.DefaultTransport}
	tr := &utlsTransport{fallback: rec}
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/ping", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("User-Agent", "node")
	resp, err := tr.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !rec.called.Load() {
		t.Fatal("http:// must use fallback RoundTripper")
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if gotUA != "node" {
		t.Fatalf("ua = %q", gotUA)
	}
}

func TestUTLSTransportHTTPSDoesNotUseFallback(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != "node" {
			t.Errorf("ua = %q", r.Header.Get("User-Agent"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0, "via": "utls"})
	}))
	defer srv.Close()

	rec := &recordingTransport{next: http.DefaultTransport}
	tr := &utlsTransport{fallback: rec, rootCAs: tlsServerPool(t, srv)}
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/ilink/bot/get_bot_qrcode", strings.NewReader(`{"local_token_list":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("User-Agent", "node")
	req.Header.Set("Content-Type", "application/json")
	resp, err := tr.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if rec.called.Load() {
		t.Fatal("https:// must not use fallback")
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"via":"utls"`) && !strings.Contains(string(body), `"via": "utls"`) {
		t.Fatalf("body = %s", body)
	}
}

func TestUTLSTransportHTTPSGzip(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		if _, err := zw.Write([]byte(`{"ret":0,"qrcode":"k"}`)); err != nil {
			t.Fatal(err)
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(buf.Bytes())
	}))
	defer srv.Close()

	client := &http.Client{
		Timeout:   5 * time.Second,
		Transport: &utlsTransport{fallback: http.DefaultTransport, rootCAs: tlsServerPool(t, srv)},
	}
	resp, err := client.Get(srv.URL + "/gz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload, err := readResponseBody(resp, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != `{"ret":0,"qrcode":"k"}` {
		t.Fatalf("payload = %s", payload)
	}
}

func TestUTLSTransportHTTPSHonorsClientTimeout(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write([]byte(`{"ret":0}`))
	}))
	defer srv.Close()

	client := &http.Client{
		Timeout: 40 * time.Millisecond,
		Transport: &utlsTransport{
			fallback: http.DefaultTransport,
			rootCAs:  tlsServerPool(t, srv),
		},
	}
	_, err := client.Get(srv.URL + "/slow")
	if err == nil {
		t.Fatal("expected timeout")
	}
}

func TestNewILinkClientAttachesUTLSToAllClients(t *testing.T) {
	c := newILinkClient("", "", nil)
	for name, cl := range map[string]*http.Client{
		"client":   c.client,
		"longPoll": c.longPoll,
		"qrStatus": c.qrStatus,
	} {
		if _, ok := cl.Transport.(*utlsTransport); !ok {
			t.Fatalf("%s transport = %T, want *utlsTransport", name, cl.Transport)
		}
	}
	if c.client.Timeout != apiTimeout {
		t.Fatalf("client timeout = %s", c.client.Timeout)
	}
	if c.longPoll.Timeout < longPollTimeout {
		t.Fatalf("longPoll timeout = %s", c.longPoll.Timeout)
	}
	if c.qrStatus.Timeout < qrStatusTimeout {
		t.Fatalf("qrStatus timeout = %s", c.qrStatus.Timeout)
	}
}

func TestNewILinkClientDoesNotMutateCallerTransport(t *testing.T) {
	in := &http.Client{Timeout: time.Second}
	_ = newILinkClient("", "", in)
	if in.Transport != nil {
		t.Fatalf("caller transport mutated: %T", in.Transport)
	}
}

func TestILinkClientHTTPSGetBotQRCode(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ilink/bot/get_bot_qrcode" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		assertNodeStyleHeaders(t, r.Header)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ret": 0, "qrcode": "qr-https", "qrcode_img_content": "https://img.example/qr",
		})
	}))
	defer srv.Close()

	c := newILinkClient(srv.URL, "", &http.Client{Timeout: apiTimeout})
	tr, ok := c.client.Transport.(*utlsTransport)
	if !ok {
		t.Fatalf("transport = %T", c.client.Transport)
	}
	tr.rootCAs = tlsServerPool(t, srv)
	qr, err := c.GetBotQRCode(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if qr.Key != "qr-https" {
		t.Fatalf("qr = %+v", qr)
	}
}

func tlsServerPool(t *testing.T, srv *httptest.Server) *x509.CertPool {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	return pool
}
