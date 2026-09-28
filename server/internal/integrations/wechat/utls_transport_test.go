package wechat

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
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
	t.Setenv(wechatHTTPSProxyEnv, "")
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

func TestNewUTLSTransportReadsProxyEnv(t *testing.T) {
	t.Setenv(wechatHTTPSProxyEnv, "http://host.docker.internal:18081")
	tr := newUTLSTransport(nil)
	if tr.proxy != "http://host.docker.internal:18081" {
		t.Fatalf("proxy = %q", tr.proxy)
	}
	t.Setenv(wechatHTTPSProxyEnv, "")
	tr = newUTLSTransport(nil)
	if tr.proxy != "" {
		t.Fatalf("empty env should leave proxy unset, got %q", tr.proxy)
	}
}

func TestNewILinkClientHonorsProxyEnv(t *testing.T) {
	t.Setenv(wechatHTTPSProxyEnv, "http://127.0.0.1:18081")
	c := newILinkClient("", "", nil)
	tr, ok := c.client.Transport.(*utlsTransport)
	if !ok {
		t.Fatalf("transport = %T", c.client.Transport)
	}
	if tr.proxy != "http://127.0.0.1:18081" {
		t.Fatalf("proxy = %q", tr.proxy)
	}
}

func TestUTLSTransportHTTPSViaCONNECTProxy(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ret": 0, "via": "proxy"})
	}))
	defer srv.Close()

	var mu sync.Mutex
	var gotTarget string
	proxyAddr := startMiniCONNECTProxy(t, func(target string) {
		mu.Lock()
		gotTarget = target
		mu.Unlock()
	})

	rec := &recordingTransport{next: http.DefaultTransport}
	tr := &utlsTransport{
		fallback: rec,
		rootCAs:  tlsServerPool(t, srv),
		proxy:    "http://" + proxyAddr,
	}
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/ilink/bot/get_bot_qrcode", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := tr.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if rec.called.Load() {
		t.Fatal("https via proxy must not use fallback")
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"via":"proxy"`) && !strings.Contains(string(body), `"via": "proxy"`) {
		t.Fatalf("body = %s", body)
	}
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	want := net.JoinHostPort(u.Hostname(), u.Port())
	mu.Lock()
	defer mu.Unlock()
	if gotTarget != want {
		t.Fatalf("CONNECT target = %q, want %q", gotTarget, want)
	}
}

func TestUTLSTransportHTTPUsesFallbackEvenWithProxy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer srv.Close()

	rec := &recordingTransport{next: http.DefaultTransport}
	tr := &utlsTransport{fallback: rec, proxy: "http://127.0.0.1:1"}
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/ping", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := tr.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !rec.called.Load() {
		t.Fatal("http:// must use fallback even when proxy is set")
	}
}

func TestUTLSTransportProxyHandshakeFailureDoesNotDialOrigin(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"ret":0}`))
	}))
	defer srv.Close()

	proxyAddr := startRejectCONNECTProxy(t, "HTTP/1.1 403 Forbidden")
	tr := &utlsTransport{
		fallback: http.DefaultTransport,
		rootCAs:  tlsServerPool(t, srv),
		proxy:    "http://" + proxyAddr,
	}
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/x", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tr.RoundTrip(req)
	if err == nil {
		t.Fatal("expected CONNECT handshake error")
	}
	if hits.Load() != 0 {
		t.Fatal("origin was reached; proxy failure must not fall back to direct dial")
	}
}

func TestUTLSTransportInvalidProxyDoesNotDialOrigin(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	defer srv.Close()

	tr := &utlsTransport{
		fallback: http.DefaultTransport,
		rootCAs:  tlsServerPool(t, srv),
		proxy:    "not-a-proxy-url",
	}
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/x", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tr.RoundTrip(req)
	if err == nil {
		t.Fatal("expected invalid proxy error")
	}
	if hits.Load() != 0 {
		t.Fatal("origin was reached; invalid proxy must not fall back to direct dial")
	}
	if strings.Contains(err.Error(), "not-a-proxy-url") {
		t.Fatalf("raw proxy value leaked in error: %v", err)
	}
}

func TestUTLSTransportProxyUserinfoNotLeaked(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()

	tr := &utlsTransport{
		fallback: http.DefaultTransport,
		rootCAs:  tlsServerPool(t, srv),
		proxy:    "http://user:super-secret-token@" + addr,
	}
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/x", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tr.RoundTrip(req)
	if err == nil {
		t.Fatal("expected dial error")
	}
	if strings.Contains(err.Error(), "super-secret-token") {
		t.Fatalf("proxy credential leaked in error: %v", err)
	}
}

func TestUTLSTransportProxyCONNECTHonorsTimeout(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		time.Sleep(time.Second)
	}()

	client := &http.Client{
		Timeout: 40 * time.Millisecond,
		Transport: &utlsTransport{
			fallback: http.DefaultTransport,
			proxy:    "http://" + ln.Addr().String(),
		},
	}
	_, err = client.Get("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode")
	if err == nil {
		t.Fatal("expected timeout during CONNECT handshake")
	}
}

func tlsServerPool(t *testing.T, srv *httptest.Server) *x509.CertPool {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	return pool
}

func startMiniCONNECTProxy(t *testing.T, onConnect func(target string)) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			client, err := ln.Accept()
			if err != nil {
				return
			}
			go serveMiniCONNECT(client, onConnect)
		}
	}()
	return ln.Addr().String()
}

func serveMiniCONNECT(client net.Conn, onConnect func(target string)) {
	defer client.Close()
	br := bufio.NewReader(client)
	line, err := br.ReadString('\n')
	if err != nil {
		return
	}
	fields := strings.Fields(line)
	if len(fields) < 2 || !strings.EqualFold(fields[0], "CONNECT") {
		_, _ = fmt.Fprint(client, "HTTP/1.1 400 Bad Request\r\n\r\n")
		return
	}
	target := fields[1]
	if onConnect != nil {
		onConnect(target)
	}
	for {
		h, err := br.ReadString('\n')
		if err != nil {
			return
		}
		if strings.TrimSpace(h) == "" {
			break
		}
	}
	upstream, err := net.Dial("tcp", target)
	if err != nil {
		_, _ = fmt.Fprint(client, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
		return
	}
	defer upstream.Close()
	if _, err := fmt.Fprint(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(upstream, br)
		if tc, ok := upstream.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(client, upstream)
	<-done
}

func startRejectCONNECTProxy(t *testing.T, statusLine string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			client, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				_, _ = br.ReadString('\n')
				for {
					h, err := br.ReadString('\n')
					if err != nil || strings.TrimSpace(h) == "" {
						break
					}
				}
				_, _ = fmt.Fprintf(c, "%s\r\n\r\n", statusLine)
			}(client)
		}
	}()
	return ln.Addr().String()
}
