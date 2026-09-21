package wechat

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
)

// wechatRawEvent carries fields the cross-platform envelope does not.
type wechatRawEvent struct {
	BotID      string `json:"bot_id"`
	EventType  string `json:"event_type"`
	SenderName string `json:"sender_name,omitempty"`
}

// inboundFromMessage normalizes one iLink user message. ok=false means the
// update must not reach the core: bot echoes, empty senders, or no content.
func inboundFromMessage(m WeixinMessage, botID string) (channel.InboundMessage, bool) {
	if m.MessageType == messageTypeBot {
		return channel.InboundMessage{}, false
	}
	if m.FromUserID == "" || m.FromUserID == botID {
		return channel.InboundMessage{}, false
	}

	text, msgType := flattenItems(m.ItemList)
	chatType := channel.ChatTypeP2P
	chatID := m.FromUserID
	if m.GroupID != "" {
		chatType = channel.ChatTypeGroup
		chatID = m.GroupID
	}

	cleaned := strings.TrimSpace(text)
	commandText := cleaned
	forceFresh := false
	if control, ok := engine.ParseControlCommand(cleaned); ok {
		cleaned = control.Body
		forceFresh = control.Kind == engine.ControlCommandFreshSession
	}

	raw, _ := json.Marshal(wechatRawEvent{
		BotID:     botID,
		EventType: "message",
	})

	messageID := wechatMessageKey(m)
	return channel.InboundMessage{
		EventID:        wechatEventID(m),
		MessageID:      messageID,
		Type:           msgType,
		Text:           cleaned,
		CommandText:    commandText,
		AddressedToBot: chatType == channel.ChatTypeP2P || cleaned != "",
		ForceFresh:     forceFresh,
		Source: channel.Source{
			ChannelType:    TypeWechat,
			ChatID:         chatID,
			ChatType:       chatType,
			SenderID:       m.FromUserID,
			SenderStableID: m.FromUserID,
		},
		Raw: raw,
	}, true
}

func wechatMessageKey(m WeixinMessage) string {
	if m.MessageID != 0 {
		return strconv.FormatInt(m.MessageID, 10)
	}
	if m.Seq != 0 {
		return "seq:" + strconv.FormatInt(m.Seq, 10)
	}
	if m.ClientID != "" {
		return "client:" + m.ClientID
	}
	return ""
}

func wechatEventID(m WeixinMessage) string {
	if m.Seq != 0 {
		return strconv.FormatInt(m.Seq, 10)
	}
	return wechatMessageKey(m)
}

func flattenItems(items []MessageItem) (string, channel.MsgType) {
	var texts []string
	msgType := channel.MsgTypeUnknown
	for _, it := range items {
		switch it.Type {
		case itemTypeText:
			if it.TextItem != nil && it.TextItem.Text != "" {
				texts = append(texts, it.TextItem.Text)
				if msgType == channel.MsgTypeUnknown {
					msgType = channel.MsgTypeText
				}
			}
		case itemTypeImage:
			if msgType == channel.MsgTypeUnknown {
				msgType = channel.MsgTypeImage
			}
		case itemTypeVoice:
			if msgType == channel.MsgTypeUnknown {
				msgType = channel.MsgTypeAudio
			}
		case itemTypeVideo:
			if msgType == channel.MsgTypeUnknown {
				msgType = channel.MsgTypeVideo
			}
		case itemTypeFile:
			if msgType == channel.MsgTypeUnknown {
				msgType = channel.MsgTypeFile
			}
		}
	}
	if len(texts) > 0 {
		return strings.Join(texts, "\n"), channel.MsgTypeText
	}
	return "", msgType
}
