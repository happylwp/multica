package wechat

import (
	"bufio"
	"context"
	"crypto/x509"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"

	utls "github.com/refraction-networking/utls"
)

// wechatHTTPSProxyEnv is the iLink-only CONNECT proxy. Empty = direct dial.
// Docker Desktop's TCP stack is risk-scored; a host-native CONNECT tunnel
// makes the egress segment look like a normal client. Handshake failure
// must not fall back to direct dial: that path yields a low-trust QR.
const wechatHTTPSProxyEnv = "MULTICA_WECHAT_HTTPS_PROXY"

// utlsTransport is an http.RoundTripper that speaks HTTPS with a Chrome TLS
// ClientHello (HelloChrome_Auto). WeChat risk-controls Go's default TLS
// fingerprint; utls is the layer that passed bind in the 2026-09-24 probe.
//
// http:// traffic (local httptest) uses fallback so existing tests stay on
// net/http. HTTPS is one new TCP+utls connection per request. iLink is
// low-frequency (QR once, status every 30s, getupdates long-poll, send
// rarely), so pooling is not worth the close-path complexity.
type utlsTransport struct {
	fallback http.RoundTripper
	rootCAs  *x509.CertPool
	// proxy is an optional http://host:port CONNECT proxy. Only iLink
	// HTTPS uses this field; other backend traffic never sees it.
	proxy string
}

func newUTLSTransport(fallback http.RoundTripper) *utlsTransport {
	if fallback == nil {
		fallback = http.DefaultTransport
	}
	return &utlsTransport{
		fallback: fallback,
		proxy:    strings.TrimSpace(os.Getenv(wechatHTTPSProxyEnv)),
	}
}

func (t *utlsTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL == nil || req.URL.Scheme != "https" {
		return t.fallback.RoundTrip(req)
	}
	return t.roundTripUTLS(req)
}

func (t *utlsTransport) roundTripUTLS(req *http.Request) (*http.Response, error) {
	if req.Body != nil {
		defer req.Body.Close()
	}

	host := req.URL.Hostname()
	port := req.URL.Port()
	if port == "" {
		port = "443"
	}

	// DialContext (not net.Dial) so Client.Timeout / ctx cancel reach the
	// TCP connect. Deadline stays on the Client; we just honor the ctx.
	// CONNECT handshake (when proxy is set) runs on the same conn after
	// deadline + AfterFunc are installed, so cancel closes the tunnel.
	d := net.Dialer{}
	var (
		conn      net.Conn
		err       error
		proxyHost string
	)
	if t.proxy != "" {
		pu, perr := parseHTTPSProxyURL(t.proxy)
		if perr != nil {
			slog.Warn("wechat: iLink CONNECT proxy invalid", "host", host, "err", perr)
			return nil, perr
		}
		proxyHost = pu.Hostname()
		conn, err = d.DialContext(req.Context(), "tcp", pu.Host)
	} else {
		conn, err = d.DialContext(req.Context(), "tcp", net.JoinHostPort(host, port))
	}
	if err != nil {
		if t.proxy != "" {
			slog.Warn("wechat: iLink CONNECT proxy dial failed", "host", host, "proxy_host", proxyHost, "err", err)
		}
		return nil, err
	}
	if deadline, ok := req.Context().Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	stop := context.AfterFunc(req.Context(), func() { _ = conn.Close() })

	if t.proxy != "" {
		tun, herr := connectHandshake(conn, host, port)
		if herr != nil {
			slog.Warn("wechat: iLink CONNECT proxy handshake failed", "host", host, "proxy_host", proxyHost, "err", herr)
			stop()
			_ = conn.Close()
			return nil, herr
		}
		conn = tun
	}

	uconn := utls.UClient(conn, &utls.Config{
		ServerName: host,
		NextProtos: []string{"http/1.1"},
		RootCAs:    t.rootCAs,
	}, utls.HelloChrome_Auto)

	fail := func(err error) (*http.Response, error) {
		stop()
		_ = uconn.Close()
		return nil, err
	}

	if err := uconn.HandshakeContext(req.Context()); err != nil {
		return fail(err)
	}
	if err := req.Write(uconn); err != nil {
		return fail(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(uconn), req)
	if err != nil {
		return fail(err)
	}
	resp.Body = &utlsBody{body: resp.Body, conn: uconn, stop: stop}
	return resp, nil
}

// utlsBody closes the per-request connection exactly once, including the
// early-return path where the caller never reads the body.
type utlsBody struct {
	body io.ReadCloser
	conn io.Closer
	stop func() bool
	once sync.Once
	err  error
}

func (b *utlsBody) Read(p []byte) (int, error) { return b.body.Read(p) }

func (b *utlsBody) Close() error {
	b.once.Do(func() {
		if b.stop != nil {
			b.stop()
		}
		bodyErr := b.body.Close()
		connErr := b.conn.Close()
		if bodyErr != nil {
			b.err = bodyErr
			return
		}
		b.err = connErr
	})
	return b.err
}

func parseHTTPSProxyURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("wechat: invalid %s", wechatHTTPSProxyEnv)
	}
	return u, nil
}

// connectHandshake writes a CONNECT request and consumes the 200 + headers
// the same way the verified /tmp/utls-probe/genqr.go dialViaProxy does.
func connectHandshake(conn net.Conn, host, port string) (net.Conn, error) {
	target := net.JoinHostPort(host, port)
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target); err != nil {
		return nil, err
	}
	br := bufio.NewReader(conn)
	line, err := br.ReadString('\n')
	if err != nil || !strings.Contains(line, "200") {
		return nil, fmt.Errorf("proxy connect failed: %q err=%v", strings.TrimSpace(line), err)
	}
	for {
		h, err := br.ReadString('\n')
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(h) == "" {
			break
		}
	}
	if br.Buffered() > 0 {
		return &bufferedConn{Conn: conn, r: br}, nil
	}
	return conn, nil
}

// bufferedConn drains bytes the CONNECT reader already pulled so the
// subsequent utls handshake does not lose a prefix.
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.r.Read(p) }
