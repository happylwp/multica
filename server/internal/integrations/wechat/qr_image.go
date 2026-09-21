package wechat

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
)

const maxQRImageBytes = 512 << 10

var (
	errQRImageEmpty     = errors.New("wechat: empty qr image url")
	errQRImageScheme    = errors.New("wechat: unsupported qr image scheme")
	errQRImageInvalid   = errors.New("wechat: invalid qr image url")
	errQRImageTransport = errors.New("wechat: qr image transport failed")
	errQRImageHTTP      = errors.New("wechat: qr image http error")
	errQRImageTooLarge  = errors.New("wechat: qr image too large")
	errQRImageBody      = errors.New("wechat: empty qr image body")
	errQRImageNotImage  = errors.New("wechat: qr image is not an image")
)

// embedQRImage turns an iLink qrcode_img_content value into a data URL the
// browser can render without fetching WeChat's host (hotlink / short-lived
// signed URLs). Errors never include the raw URL: those values carry session
// keys.
func embedQRImage(ctx context.Context, client *http.Client, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errQRImageEmpty
	}
	if strings.HasPrefix(raw, "data:image/") {
		return raw, nil
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", errQRImageInvalid
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errQRImageScheme
	}
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return "", errQRImageInvalid
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errQRImageTransport
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("%w: %d", errQRImageHTTP, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxQRImageBytes+1))
	if err != nil {
		return "", errQRImageTransport
	}
	if len(body) > maxQRImageBytes {
		return "", errQRImageTooLarge
	}
	if len(body) == 0 {
		return "", errQRImageBody
	}
	mediaType := ""
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		mediaType, _, _ = mime.ParseMediaType(ct)
	}
	if !strings.HasPrefix(mediaType, "image/") {
		mediaType = http.DetectContentType(body)
	}
	if !strings.HasPrefix(mediaType, "image/") {
		return "", errQRImageNotImage
	}
	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(body), nil
}

// qrImageURLLogMeta returns a query-stripped prefix and the original length so
// logs can say which host failed without echoing session keys.
func qrImageURLLogMeta(raw string) (prefix string, n int) {
	n = len(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		if n > 64 {
			return raw[:64], n
		}
		return raw, n
	}
	return u.Scheme + "://" + u.Host + u.EscapedPath(), n
}

func qrImageFetchKind(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, errQRImageEmpty), errors.Is(err, errQRImageBody):
		return "empty"
	case errors.Is(err, errQRImageScheme), errors.Is(err, errQRImageInvalid):
		return "invalid_url"
	case errors.Is(err, errQRImageTooLarge):
		return "too_large"
	case errors.Is(err, errQRImageNotImage):
		return "not_image"
	case errors.Is(err, errQRImageHTTP):
		return "http_status"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "timeout"
	default:
		return "fetch_failed"
	}
}
