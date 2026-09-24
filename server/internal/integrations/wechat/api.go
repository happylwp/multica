package wechat

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Official iLink host. QR login always uses this host; post-login calls
// follow the account's baseurl when the QR confirm response supplies one.
const defaultAPIBase = "https://ilinkai.weixin.qq.com"

const (
	defaultChannelVersion = "1.0.3"
	defaultBotAgent       = "Multica"
	defaultILinkAppID     = "openclaw-weixin"
	// officialPluginVersion is @tencent-weixin/openclaw-weixin; WeChat
	// risk-controls iLink-App-ClientVersion against this encoding.
	officialPluginVersion = "2.4.9"
	nodeUserAgent         = "node"
	longPollTimeout       = 40 * time.Second
	apiTimeout            = 15 * time.Second
	qrStatusTimeout       = 75 * time.Second
)

// Official QR statuses (openclaw-weixin backend-api). "scaned" is the
// protocol spelling, not a typo.
const (
	QRStatusWait            = "wait"
	QRStatusScanned         = "scaned"
	QRStatusNeedVerify      = "need_verifycode"
	QRStatusVerifyBlocked   = "verify_code_blocked"
	QRStatusExpired         = "expired"
	QRStatusScannedRedirect = "scaned_but_redirect"
	QRStatusBoundRedirect   = "binded_redirect"
	QRStatusConfirmed       = "confirmed"
)

// ErrSessionExpired is iLink errcode -14: the bot token is stale and the
// operator must re-scan. Supervisor backoff cannot fix this.
var ErrSessionExpired = errors.New("wechat: iLink session expired; re-scan required")

// requestError deliberately omits the URL from Error(). Authenticated iLink
// URLs and transport errors must not leak the bearer token through logs.
type requestError struct {
	method string
	cause  error
}

func (e *requestError) Error() string { return fmt.Sprintf("wechat: %s request failed", e.method) }

func (e *requestError) Unwrap() error { return e.cause }

type apiError struct {
	Ret     int
	ErrCode int
	ErrMsg  string
}

func (e *apiError) Error() string {
	if e.ErrMsg != "" {
		return fmt.Sprintf("wechat ilink: ret=%d errcode=%d", e.Ret, e.ErrCode)
	}
	return fmt.Sprintf("wechat ilink: ret=%d errcode=%d", e.Ret, e.ErrCode)
}

func (e *apiError) expired() bool { return e.ErrCode == -14 }

// iLinkClient is one account's iLink HTTP client.
type iLinkClient struct {
	loginBase string
	apiBase   string
	token     string
	appID     string
	version   string
	botAgent  string
	client    *http.Client
	longPoll  *http.Client
	qrStatus  *http.Client
}

func newILinkClient(apiBase, token string, httpClient *http.Client) *iLinkClient {
	if apiBase == "" {
		apiBase = defaultAPIBase
	}
	apiBase = strings.TrimRight(apiBase, "/")
	if httpClient == nil {
		httpClient = &http.Client{Timeout: apiTimeout}
	} else {
		// Copy so a shared caller client (InstallService, tests) is not
		// mutated when we attach the iLink-only utls transport.
		cp := *httpClient
		httpClient = &cp
	}
	httpClient.Transport = newUTLSTransport(httpClient.Transport)
	longPoll := *httpClient
	if longPoll.Timeout < longPollTimeout {
		longPoll.Timeout = longPollTimeout
	}
	qrStatus := *httpClient
	if qrStatus.Timeout < qrStatusTimeout {
		qrStatus.Timeout = qrStatusTimeout
	}
	return &iLinkClient{
		loginBase: defaultLoginBase(apiBase),
		apiBase:   apiBase,
		token:     token,
		appID:     defaultILinkAppID,
		version:   defaultChannelVersion,
		botAgent:  defaultBotAgent,
		client:    httpClient,
		longPoll:  &longPoll,
		qrStatus:  &qrStatus,
	}
}

func defaultLoginBase(apiBase string) string {
	// QR login is always Tencent's fixed service. Tests point apiBase at
	// httptest and expect QR + messaging on the same host.
	if strings.Contains(apiBase, "127.0.0.1") || strings.Contains(apiBase, "localhost") || strings.HasPrefix(apiBase, "http://") {
		return apiBase
	}
	return defaultAPIBase
}

func (c *iLinkClient) withToken(token string) *iLinkClient {
	cp := *c
	cp.token = token
	return &cp
}

func (c *iLinkClient) withAPIBase(base string) *iLinkClient {
	if base == "" {
		return c
	}
	cp := *c
	cp.apiBase = strings.TrimRight(base, "/")
	return &cp
}

type baseInfo struct {
	ChannelVersion string `json:"channel_version"`
	BotAgent       string `json:"bot_agent,omitempty"`
}

func (c *iLinkClient) baseInfo() baseInfo {
	return baseInfo{ChannelVersion: c.version, BotAgent: c.botAgent}
}

// buildClientVersion encodes major.minor.patch as official 0x00MMNNPP
// (high 8 bits 0; major<<16 | minor<<8 | patch). "2.4.9" -> 132105.
func buildClientVersion(version string) string {
	var major, minor, patch int
	parts := strings.Split(version, ".")
	if len(parts) > 0 {
		major, _ = strconv.Atoi(parts[0])
	}
	if len(parts) > 1 {
		minor, _ = strconv.Atoi(parts[1])
	}
	if len(parts) > 2 {
		patch, _ = strconv.Atoi(parts[2])
	}
	n := ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
	return strconv.Itoa(n)
}

func (c *iLinkClient) setCommonHeaders(req *http.Request, authenticated bool) {
	// Match Node undici fetch defaults. WeChat signs these; Go's implicit
	// User-Agent (Go-http-client/1.1) is rejected at QR bind.
	req.Header.Set("User-Agent", nodeUserAgent)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Language", "*")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Accept-Encoding", "gzip, deflate")
	req.Header.Set("iLink-App-Id", c.appID)
	req.Header.Set("iLink-App-ClientVersion", buildClientVersion(officialPluginVersion))
	if req.Method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("AuthorizationType", "ilink_bot_token")
		req.Header.Set("X-WECHAT-UIN", randomWechatUIN())
		if authenticated && c.token != "" {
			req.Header.Set("Authorization", "Bearer "+c.token)
		}
	}
}

func randomWechatUIN() string {
	var n uint32
	_ = binary.Read(rand.Reader, binary.LittleEndian, &n)
	return base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%d", n)))
}

func randomClientID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// readResponseBody reads at most limit bytes. Setting Accept-Encoding
// ourselves disables Transport's transparent gzip, so gzip bodies must
// be decoded here before JSON parse.
func readResponseBody(resp *http.Response, limit int64) ([]byte, error) {
	var r io.Reader = resp.Body
	if strings.EqualFold(strings.TrimSpace(resp.Header.Get("Content-Encoding")), "gzip") {
		gr, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer gr.Close()
		r = gr
	}
	return io.ReadAll(io.LimitReader(r, limit))
}

func (c *iLinkClient) do(ctx context.Context, client *http.Client, method, path string, query url.Values, body any, authenticated bool, out any) error {
	if client == nil {
		client = c.client
	}
	var raw io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("wechat: encode %s: %w", path, err)
		}
		raw = bytes.NewReader(buf)
	}
	base := c.apiBase
	if strings.Contains(path, "qrcode") {
		base = c.loginBase
	}
	u := base + "/" + strings.TrimPrefix(path, "/")
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, raw)
	if err != nil {
		return fmt.Errorf("wechat: build %s request: %w", path, err)
	}
	c.setCommonHeaders(req, authenticated)
	resp, err := client.Do(req)
	if err != nil {
		return &requestError{method: path, cause: err}
	}
	defer resp.Body.Close()
	payload, err := readResponseBody(resp, 1<<20)
	if err != nil {
		return fmt.Errorf("wechat: read %s response: %w", path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("wechat: %s http %d", path, resp.StatusCode)
	}
	var st wireStatus
	if json.Unmarshal(payload, &st) == nil {
		if err := apiStatusError(st.Ret, st.ErrCode, st.ErrMsg); err != nil {
			return err
		}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("wechat: decode %s response (http %d): %w", path, resp.StatusCode, err)
	}
	return nil
}

type wireStatus struct {
	Ret     int    `json:"ret"`
	ErrCode int    `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}

func apiStatusError(ret, errcode int, errmsg string) error {
	if ret == 0 && errcode == 0 {
		return nil
	}
	ae := &apiError{Ret: ret, ErrCode: errcode, ErrMsg: errmsg}
	if ae.expired() {
		return ErrSessionExpired
	}
	return ae
}

// QRCode is the get_bot_qrcode result. ImageURL is rendered as the QR;
// Key is the opaque handle the status poll uses.
type QRCode struct {
	Key      string `json:"qrcode"`
	ImageURL string `json:"qrcode_img_content"`
}

type qrCodeRequest struct {
	LocalTokenList []string `json:"local_token_list"`
}

// GetBotQRCode starts a QR login session. Official: POST with an empty
// local_token_list (we never echo stored tokens onto the wire here).
func (c *iLinkClient) GetBotQRCode(ctx context.Context) (QRCode, error) {
	var out QRCode
	err := c.do(ctx, c.client, http.MethodPost, "ilink/bot/get_bot_qrcode",
		url.Values{"bot_type": []string{"3"}},
		qrCodeRequest{LocalTokenList: []string{}},
		false, &out)
	if err != nil {
		return QRCode{}, err
	}
	if out.Key == "" {
		return QRCode{}, errors.New("wechat: empty qrcode in get_bot_qrcode response")
	}
	return out, nil
}

// QRStatus is one get_qrcode_status snapshot. Confirmed fills Token / BotID /
// UserID / BaseURL. Those fields are secrets or identifiers — never log them.
type QRStatus struct {
	Status   string `json:"status"`
	Token    string `json:"bot_token,omitempty"`
	BotID    string `json:"ilink_bot_id,omitempty"`
	UserID   string `json:"ilink_user_id,omitempty"`
	BaseURL  string `json:"baseurl,omitempty"`
	Nickname string `json:"nickname,omitempty"`
	Redirect string `json:"redirect_host,omitempty"`
}

func isClientTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func (c *iLinkClient) qrStatusClient() *http.Client {
	if c != nil && c.qrStatus != nil {
		return c.qrStatus
	}
	if c != nil && c.client != nil {
		return c.client
	}
	return &http.Client{Timeout: qrStatusTimeout}
}

// GetQRCodeStatus long-polls one QR session. Official: GET.
// Upstream holds a live key until scan/expiry; a 15s client timeout looks
// like 503 to the settings page. Timeouts are "still waiting", not errors.
func (c *iLinkClient) GetQRCodeStatus(ctx context.Context, qrcode, verifyCode string) (QRStatus, error) {
	q := url.Values{"qrcode": []string{qrcode}}
	if verifyCode != "" {
		q.Set("verify_code", verifyCode)
	}
	var out QRStatus
	err := c.do(ctx, c.qrStatusClient(), http.MethodGet, "ilink/bot/get_qrcode_status", q, nil, false, &out)
	if err != nil {
		if isClientTimeout(err) {
			return QRStatus{Status: QRStatusWait}, nil
		}
		return QRStatus{}, err
	}
	if out.Status == "" {
		out.Status = QRStatusWait
	}
	return out, nil
}

type envelope struct {
	Ret                  int             `json:"ret"`
	ErrCode              int             `json:"errcode"`
	ErrMsg               string          `json:"errmsg"`
	Msgs                 []WeixinMessage `json:"msgs"`
	GetUpdatesBuf        string          `json:"get_updates_buf"`
	LongPollingTimeoutMS int             `json:"longpolling_timeout_ms"`
	TypingTicket         string          `json:"typing_ticket"`
}

type getUpdatesBody struct {
	GetUpdatesBuf string   `json:"get_updates_buf"`
	BaseInfo      baseInfo `json:"base_info"`
}

// GetUpdates long-polls for inbound messages. The returned cursor must be
// sent back on the next call.
func (c *iLinkClient) GetUpdates(ctx context.Context, cursor string) (envelope, error) {
	var env envelope
	err := c.do(ctx, c.longPoll, http.MethodPost, "ilink/bot/getupdates", nil,
		getUpdatesBody{GetUpdatesBuf: cursor, BaseInfo: c.baseInfo()},
		true, &env)
	if err != nil {
		return envelope{}, err
	}
	return env, nil
}

// WeixinMessage is the official getupdates item (fields we consume).
type WeixinMessage struct {
	Seq          int64         `json:"seq"`
	MessageID    int64         `json:"message_id"`
	FromUserID   string        `json:"from_user_id"`
	ToUserID     string        `json:"to_user_id"`
	ClientID     string        `json:"client_id"`
	CreateTimeMS int64         `json:"create_time_ms"`
	SessionID    string        `json:"session_id"`
	GroupID      string        `json:"group_id"`     // ignored: personal ClawBot is 1:1; see inboundFromMessage
	MessageType  int           `json:"message_type"` // 1=USER 2=BOT
	MessageState int           `json:"message_state"`
	ItemList     []MessageItem `json:"item_list"`
	ContextToken string        `json:"context_token"`
}

// MessageItem is one content part. Type 1 is text.
type MessageItem struct {
	Type     int `json:"type"`
	TextItem *struct {
		Text string `json:"text"`
	} `json:"text_item,omitempty"`
}

const (
	messageTypeUser = 1
	messageTypeBot  = 2
	itemTypeText    = 1
	itemTypeImage   = 2
	itemTypeVoice   = 3
	itemTypeFile    = 4
	itemTypeVideo   = 5
)

type sendMessageBody struct {
	Msg      sendMessage `json:"msg"`
	BaseInfo baseInfo    `json:"base_info"`
}

type sendMessage struct {
	FromUserID   string        `json:"from_user_id"`
	ToUserID     string        `json:"to_user_id"`
	ClientID     string        `json:"client_id"`
	MessageType  int           `json:"message_type"`
	MessageState int           `json:"message_state"`
	ContextToken string        `json:"context_token"`
	ItemList     []MessageItem `json:"item_list"`
}

// SendText posts one independent text message. contextToken must come from
// the latest inbound in this conversation; the caller enforces the 24h window
// before invoking this.
func (c *iLinkClient) SendText(ctx context.Context, toUserID, contextToken, text string) error {
	var env envelope
	return c.do(ctx, c.client, http.MethodPost, "ilink/bot/sendmessage", nil, sendMessageBody{
		Msg: sendMessage{
			FromUserID:   "",
			ToUserID:     toUserID,
			ClientID:     randomClientID(),
			MessageType:  messageTypeBot,
			MessageState: 2,
			ContextToken: contextToken,
			ItemList: []MessageItem{{
				Type: itemTypeText,
				TextItem: &struct {
					Text string `json:"text"`
				}{Text: text},
			}},
		},
		BaseInfo: c.baseInfo(),
	}, true, &env)
}

type notifyBody struct {
	BaseInfo baseInfo `json:"base_info"`
}

func (c *iLinkClient) NotifyStart(ctx context.Context) error {
	var env envelope
	return c.do(ctx, c.client, http.MethodPost, "ilink/bot/msg/notifystart", nil, notifyBody{BaseInfo: c.baseInfo()}, true, &env)
}

func (c *iLinkClient) NotifyStop(ctx context.Context) error {
	var env envelope
	return c.do(ctx, c.client, http.MethodPost, "ilink/bot/msg/notifystop", nil, notifyBody{BaseInfo: c.baseInfo()}, true, &env)
}
