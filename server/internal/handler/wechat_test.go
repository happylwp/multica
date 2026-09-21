package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/wechat"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestListWechatInstallationsNotConfiguredReturnsEmpty(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces/x/wechat/installations", nil)
	w := httptest.NewRecorder()
	h.ListWechatInstallations(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Installations    []any `json:"installations"`
		Configured       bool  `json:"configured"`
		InstallSupported bool  `json:"install_supported"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Configured || resp.InstallSupported || len(resp.Installations) != 0 {
		t.Fatalf("unexpected unconfigured response: %+v", resp)
	}
}

func TestWechatMutationHandlersRejectUnconfiguredDeployment(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		body   string
		run    func(*Handler, http.ResponseWriter, *http.Request)
	}{
		{"start qr", http.MethodPost, "/api/workspaces/x/wechat/qrcode?agent_id=y", "", (*Handler).StartWechatQR},
		{"poll qr", http.MethodPost, "/api/workspaces/x/wechat/qrcode/status", `{"qrcode":"q"}`, (*Handler).PollWechatQR},
		{"revoke", http.MethodDelete, "/api/workspaces/x/wechat/installations/y", "", (*Handler).RevokeWechatInstallation},
		{"redeem", http.MethodPost, "/api/wechat/binding/redeem", `{"token":"t"}`, (*Handler).RedeemWechatBindingToken},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &Handler{}
			req := httptest.NewRequest(tt.method, tt.path, strings.NewReader(tt.body))
			w := httptest.NewRecorder()
			tt.run(h, w, req)
			if w.Code != http.StatusForbidden {
				t.Fatalf("expected 403, got %d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestWechatInstallationResponseNeverExposesStoredCredential(t *testing.T) {
	now := time.Date(2026, 9, 21, 1, 0, 0, 0, time.UTC)
	row := db.ChannelInstallation{
		ID:              parseUUID("11111111-1111-1111-1111-111111111111"),
		WorkspaceID:     parseUUID("22222222-2222-2222-2222-222222222222"),
		AgentID:         parseUUID("33333333-3333-3333-3333-333333333333"),
		InstallerUserID: parseUUID("44444444-4444-4444-4444-444444444444"),
		Status:          "active",
		Config: json.RawMessage(
			`{"app_id":"bot-1","nickname":"Ada","ilink_user_id":"wxid_x","bot_token_encrypted":"ciphertext-sentinel"}`,
		),
		InstalledAt: pgtype.Timestamptz{Time: now, Valid: true},
		CreatedAt:   pgtype.Timestamptz{Time: now, Valid: true},
		UpdatedAt:   pgtype.Timestamptz{Time: now, Valid: true},
	}
	got := wechatInstallationToResponse(row, wechat.QuotaView{Remaining: 8, WindowValid: true})
	if got.BotID != "bot-1" || got.Nickname != "Ada" || got.RemainingQuota != 8 {
		t.Fatalf("public = %+v", got)
	}
	payload, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "ciphertext-sentinel") || strings.Contains(string(payload), "bot_token") {
		t.Fatalf("management response exposed stored credential: %s", payload)
	}
}
