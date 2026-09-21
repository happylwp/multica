package wechat

import (
	"encoding/json"
	"testing"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
)

func TestInboundFromMessageText(t *testing.T) {
	m := WeixinMessage{
		MessageID:    9,
		Seq:          4,
		FromUserID:   "wxid_alice",
		MessageType:  messageTypeUser,
		ContextToken: "ctx",
		ItemList: []MessageItem{{Type: itemTypeText, TextItem: &struct {
			Text string `json:"text"`
		}{Text: "hello"}}},
	}
	msg, ok := inboundFromMessage(m, "bot-1")
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.MessageID != "9" || msg.EventID != "4" || msg.Text != "hello" {
		t.Fatalf("ids/text = %+v", msg)
	}
	if msg.Source.ChatType != channel.ChatTypeP2P || msg.Source.SenderID != "wxid_alice" || !msg.AddressedToBot {
		t.Fatalf("source = %+v", msg.Source)
	}
	var raw wechatRawEvent
	if err := json.Unmarshal(msg.Raw, &raw); err != nil || raw.BotID != "bot-1" {
		t.Fatalf("raw = %+v err=%v", raw, err)
	}
}

func TestInboundDropsBotEchoAndSelf(t *testing.T) {
	bot := WeixinMessage{FromUserID: "wxid_x", MessageType: messageTypeBot, ItemList: []MessageItem{{Type: 1, TextItem: &struct {
		Text string `json:"text"`
	}{Text: "x"}}}}
	if _, ok := inboundFromMessage(bot, "bot"); ok {
		t.Fatal("bot echo")
	}
	self := WeixinMessage{FromUserID: "bot", MessageType: messageTypeUser, ItemList: []MessageItem{{Type: 1, TextItem: &struct {
		Text string `json:"text"`
	}{Text: "x"}}}}
	if _, ok := inboundFromMessage(self, "bot"); ok {
		t.Fatal("self")
	}
}

func TestInboundGroupAndUnsupported(t *testing.T) {
	m := WeixinMessage{
		MessageID: 1, FromUserID: "u", GroupID: "g", MessageType: messageTypeUser,
		ItemList: []MessageItem{{Type: itemTypeImage}},
	}
	msg, ok := inboundFromMessage(m, "bot")
	if !ok || msg.Source.ChatType != channel.ChatTypeGroup || msg.Source.ChatID != "g" {
		t.Fatalf("group = %+v ok=%v", msg, ok)
	}
	if msg.Type != channel.MsgTypeImage {
		t.Fatalf("type = %q", msg.Type)
	}
}

func TestInboundFreshCommand(t *testing.T) {
	m := WeixinMessage{
		MessageID: 1, FromUserID: "u", MessageType: messageTypeUser,
		ItemList: []MessageItem{{Type: 1, TextItem: &struct {
			Text string `json:"text"`
		}{Text: "/clear"}}},
	}
	msg, ok := inboundFromMessage(m, "bot")
	if !ok || !msg.ForceFresh {
		t.Fatalf("fresh = %+v ok=%v", msg, ok)
	}
}
