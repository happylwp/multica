package wechat

import (
	"encoding/base64"
	"errors"
	"net/url"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

const qrImageSize = 256

var (
	errQRImageEmpty   = errors.New("wechat: empty qr landing url")
	errQRImageScheme  = errors.New("wechat: unsupported qr landing scheme")
	errQRImageInvalid = errors.New("wechat: invalid qr landing url")
	errQRImageEncode  = errors.New("wechat: qr encode failed")
)

// encodeQRImage turns the iLink landing-page URL into a PNG data URL.
// WeChat's qrcode_img_content is an H5 page (text/html), not an image —
// fetching it cannot produce <img src>. Encoding the URL itself as a QR
// keeps the scan → official landing page → bind path intact. Errors never
// include the raw URL: those values carry session keys.
func encodeQRImage(raw string) (string, error) {
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
	png, err := qrcode.Encode(raw, qrcode.Medium, qrImageSize)
	if err != nil {
		return "", errQRImageEncode
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

func qrImageEncodeKind(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, errQRImageEmpty):
		return "empty"
	case errors.Is(err, errQRImageScheme), errors.Is(err, errQRImageInvalid):
		return "invalid_url"
	default:
		return "encode_failed"
	}
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
