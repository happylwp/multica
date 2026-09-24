package wechat

import (
	"bufio"
	"context"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"sync"

	utls "github.com/refraction-networking/utls"
)

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
}

func newUTLSTransport(fallback http.RoundTripper) *utlsTransport {
	if fallback == nil {
		fallback = http.DefaultTransport
	}
	return &utlsTransport{fallback: fallback}
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
	d := net.Dialer{}
	conn, err := d.DialContext(req.Context(), "tcp", net.JoinHostPort(host, port))
	if err != nil {
		return nil, err
	}
	if deadline, ok := req.Context().Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	stop := context.AfterFunc(req.Context(), func() { _ = conn.Close() })

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
