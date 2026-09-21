// Package wechat is the personal WeChat / iLink (ClawBot) adapter.
//
// Official protocol: HTTP/JSON against ilinkai.weixin.qq.com. Binding is QR
// login (not a pasted bot token). Inbound is per-installation getupdates long
// polling supervised by engine.Supervisor, same shape as Telegram. Outbound
// is REST sendmessage. Official hard limits — a 24h inbound session window
// and 10 independent bot messages per rolling 24h — are enforced here before
// any send, including proactive issue-done pushes. Caching a context_token
// past the window to bypass that limit is not a supported path.
package wechat

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
)

// TypeWechat is the channel discriminator. Aliased from the core constant so
// registry registration never invents a second slug.
const TypeWechat = channel.TypeWechat

const channelTypeWechat = string(TypeWechat)

// installConfig is the JSON stored in channel_installation.config.
//
// app_id is the iLink bot id (ilink_bot_id) and fills the generic
// (channel_type, config->>'app_id') routing slot.
//
// bot_token_encrypted and each session's context_token_encrypted are
// base64-encoded secretbox ciphertext. Never log them.
type installConfig struct {
	AppID             string                      `json:"app_id"`
	Nickname          string                      `json:"nickname,omitempty"`
	ILinkUserID       string                      `json:"ilink_user_id,omitempty"`
	BotTokenEncrypted string                      `json:"bot_token_encrypted"`
	BaseURL           string                      `json:"baseurl,omitempty"`
	SupportMarkdown   bool                        `json:"support_markdown,omitempty"`
	GetUpdatesBuf     string                      `json:"get_updates_buf,omitempty"`
	Sessions          map[string]persistedSession `json:"sessions,omitempty"`
}

// persistedSession is the at-rest snapshot of one WeChat conversation: the
// encrypted context_token plus the timestamps the quota window is rebuilt from.
type persistedSession struct {
	ContextTokenEncrypted string      `json:"context_token_encrypted,omitempty"`
	LastInboundAt         time.Time   `json:"last_inbound_at,omitempty"`
	OutboundAt            []time.Time `json:"outbound_at,omitempty"`
}

// credentials is the decrypted runtime form.
type credentials struct {
	BotID           string
	Nickname        string
	ILinkUserID     string
	BotToken        string
	BaseURL         string
	SupportMarkdown bool
	GetUpdatesBuf   string
}

// Decrypter turns stored ciphertext into plaintext. Tests inject nil (stored
// bytes are treated as plaintext), matching telegram/slack.
type Decrypter func(ciphertext []byte) (plaintext []byte, err error)

// Encrypter seals plaintext for at-rest storage. Tests inject nil.
type Encrypter func(plaintext []byte) (ciphertext []byte, err error)

// PublicConfig is the non-secret subset safe to surface on the management API.
type PublicConfig struct {
	BotID           string
	Nickname        string
	ILinkUserID     string
	SupportMarkdown bool
}

// DecodePublicConfig extracts display-safe fields. A decode miss yields a
// zero value so the management list still renders the row.
func DecodePublicConfig(raw json.RawMessage) PublicConfig {
	var cfg installConfig
	_ = json.Unmarshal(raw, &cfg)
	return PublicConfig{
		BotID:           cfg.AppID,
		Nickname:        cfg.Nickname,
		ILinkUserID:     cfg.ILinkUserID,
		SupportMarkdown: cfg.SupportMarkdown,
	}
}

func decodeInstallConfig(raw json.RawMessage) (installConfig, error) {
	if len(raw) == 0 {
		return installConfig{}, errors.New("wechat: empty installation config")
	}
	var cfg installConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return installConfig{}, fmt.Errorf("decode wechat installation config: %w", err)
	}
	return cfg, nil
}

func decodeCredentials(raw json.RawMessage, decrypt Decrypter) (credentials, error) {
	cfg, err := decodeInstallConfig(raw)
	if err != nil {
		return credentials{}, err
	}
	token, err := decryptToken(cfg.BotTokenEncrypted, decrypt)
	if err != nil {
		return credentials{}, fmt.Errorf("decrypt wechat bot token: %w", err)
	}
	return credentials{
		BotID:           cfg.AppID,
		Nickname:        cfg.Nickname,
		ILinkUserID:     cfg.ILinkUserID,
		BotToken:        token,
		BaseURL:         cfg.BaseURL,
		SupportMarkdown: cfg.SupportMarkdown,
		GetUpdatesBuf:   cfg.GetUpdatesBuf,
	}, nil
}

func decryptToken(enc string, decrypt Decrypter) (string, error) {
	if enc == "" {
		return "", nil
	}
	ciphertext, err := base64.StdEncoding.DecodeString(stripWhitespace(enc))
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}
	if decrypt == nil {
		return string(ciphertext), nil
	}
	plaintext, err := decrypt(ciphertext)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func encryptToken(plain string, encrypt Encrypter) (string, error) {
	if plain == "" {
		return "", nil
	}
	raw := []byte(plain)
	if encrypt != nil {
		sealed, err := encrypt(raw)
		if err != nil {
			return "", err
		}
		raw = sealed
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

func stripWhitespace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case ' ', '\t', '\n', '\r':
			continue
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
