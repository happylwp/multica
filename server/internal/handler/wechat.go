package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/multica-ai/multica/server/internal/integrations/wechat"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// WechatInstallationResponse is the wire shape for a WeChat installation.
// Encrypted tokens and context_tokens are INTENTIONALLY absent.
type WechatInstallationResponse struct {
	ID              string `json:"id"`
	WorkspaceID     string `json:"workspace_id"`
	AgentID         string `json:"agent_id"`
	BotID           string `json:"bot_id"`
	Nickname        string `json:"nickname"`
	ILinkUserID     string `json:"ilink_user_id"`
	InstallerUserID string `json:"installer_user_id"`
	Status          string `json:"status"`
	SupportMarkdown bool   `json:"support_markdown"`
	RemainingQuota  int    `json:"remaining_quota"`
	WindowValid     bool   `json:"window_valid"`
	WindowExpiresAt string `json:"window_expires_at,omitempty"`
	LastInboundAt   string `json:"last_inbound_at,omitempty"`
	InstalledAt     string `json:"installed_at"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
}

func wechatInstallationToResponse(row db.ChannelInstallation, view wechat.QuotaView) WechatInstallationResponse {
	info := wechat.DecodePublicConfig(row.Config)
	out := WechatInstallationResponse{
		ID:              uuidToString(row.ID),
		WorkspaceID:     uuidToString(row.WorkspaceID),
		AgentID:         uuidToString(row.AgentID),
		BotID:           info.BotID,
		Nickname:        info.Nickname,
		ILinkUserID:     info.ILinkUserID,
		InstallerUserID: uuidToString(row.InstallerUserID),
		Status:          row.Status,
		SupportMarkdown: info.SupportMarkdown,
		RemainingQuota:  view.Remaining,
		WindowValid:     view.WindowValid,
		InstalledAt:     row.InstalledAt.Time.UTC().Format(time.RFC3339),
		CreatedAt:       row.CreatedAt.Time.UTC().Format(time.RFC3339),
		UpdatedAt:       row.UpdatedAt.Time.UTC().Format(time.RFC3339),
	}
	if !view.WindowExpiresAt.IsZero() {
		out.WindowExpiresAt = view.WindowExpiresAt.UTC().Format(time.RFC3339)
	}
	if !view.LastInboundAt.IsZero() {
		out.LastInboundAt = view.LastInboundAt.UTC().Format(time.RFC3339)
	}
	return out
}

func wechatQuotaView(h *Handler, row db.ChannelInstallation) wechat.QuotaView {
	if h == nil || h.WechatInstall == nil {
		return wechat.QuotaView{}
	}
	return h.WechatInstall.QuotaFor(row, time.Now())
}

// ListWechatInstallations (GET /api/workspaces/{id}/wechat/installations)
func (h *Handler) ListWechatInstallations(w http.ResponseWriter, r *http.Request) {
	if h.WechatInstall == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"installations":     []WechatInstallationResponse{},
			"configured":        false,
			"install_supported": false,
		})
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	rows, err := h.WechatInstall.ListByWorkspace(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list wechat installations")
		return
	}
	out := make([]WechatInstallationResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, wechatInstallationToResponse(row, wechatQuotaView(h, row)))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"installations":     out,
		"configured":        true,
		"install_supported": true,
	})
}

// StartWechatQR (POST /api/workspaces/{id}/wechat/qrcode?agent_id=…)
// starts an iLink QR login session for an agent. Admin-only at the router.
func (h *Handler) StartWechatQR(w http.ResponseWriter, r *http.Request) {
	if h.WechatInstall == nil {
		writeFeatureDisabled(w, "wechat_not_configured", "wechat integration not enabled")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	agentIDStr := strings.TrimSpace(r.URL.Query().Get("agent_id"))
	if agentIDStr == "" {
		writeError(w, http.StatusBadRequest, "agent_id is required")
		return
	}
	agentUUID, ok := parseUUIDOrBadRequest(w, agentIDStr, "agent_id")
	if !ok {
		return
	}
	if _, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{
		ID:          agentUUID,
		WorkspaceID: wsUUID,
	}); err != nil {
		writeError(w, http.StatusNotFound, "agent not found in this workspace")
		return
	}
	initiatorUUID, ok := parseUUIDOrBadRequest(w, userID, "user id")
	if !ok {
		return
	}
	started, err := h.WechatInstall.StartQR(r.Context(), wechat.StartQRParams{
		WorkspaceID: wsUUID,
		AgentID:     agentUUID,
		InitiatorID: initiatorUUID,
	})
	if err != nil {
		if errors.Is(err, wechat.ErrQRUnreachable) {
			writeError(w, http.StatusServiceUnavailable, "could not reach WeChat to start QR login")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to start wechat QR login")
		return
	}
	writeJSON(w, http.StatusOK, wechatQRStartBody(started))
}

func wechatQRStartBody(started wechat.StartedQR) map[string]any {
	body := map[string]any{
		"qrcode":             started.Key,
		"qrcode_img_content": started.ImageContent,
		"qrcode_url":         started.ImageURL,
		"expires_in":         started.ExpiresIn,
	}
	if started.ImageError != "" {
		body["error"] = started.ImageError
	}
	return body
}

// WechatQRStatusRequest is the body for POST .../wechat/qrcode/status.
type WechatQRStatusRequest struct {
	QRCode     string `json:"qrcode"`
	VerifyCode string `json:"verify_code,omitempty"`
}

// PollWechatQR (POST /api/workspaces/{id}/wechat/qrcode/status) polls one
// QR session. This is the Multica-side status endpoint the settings page
// long-polls; upstream iLink uses GET /ilink/bot/get_qrcode_status.
func (h *Handler) PollWechatQR(w http.ResponseWriter, r *http.Request) {
	if h.WechatInstall == nil {
		writeFeatureDisabled(w, "wechat_not_configured", "wechat integration not enabled")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	var body WechatQRStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.QRCode) == "" {
		writeError(w, http.StatusBadRequest, "qrcode is required")
		return
	}
	polled, err := h.WechatInstall.PollQR(r.Context(), wechat.PollQRParams{
		WorkspaceID: wsUUID,
		QRCode:      body.QRCode,
		VerifyCode:  body.VerifyCode,
	})
	if err != nil {
		switch {
		case errors.Is(err, wechat.ErrQRSessionUnknown):
			writeError(w, http.StatusGone, "qr session unknown or expired")
		case errors.Is(err, wechat.ErrQRNotInWorkspace):
			writeError(w, http.StatusNotFound, "qr session not found")
		case errors.Is(err, wechat.ErrAccountOwnedBySameWorkspace):
			writeError(w, http.StatusConflict, "this WeChat account is already connected to another agent in this workspace")
		case errors.Is(err, wechat.ErrAccountOwnedByArchivedAgent):
			writeError(w, http.StatusConflict, "this WeChat account is connected to an archived agent in this workspace")
		case errors.Is(err, wechat.ErrAccountOwnedByAnotherWorkspace):
			writeError(w, http.StatusConflict, "this WeChat account is already connected to a different Multica workspace")
		case errors.Is(err, wechat.ErrQRUnreachable):
			writeError(w, http.StatusServiceUnavailable, "could not reach WeChat to poll QR status")
		default:
			writeError(w, http.StatusInternalServerError, "failed to poll wechat QR status")
		}
		return
	}
	resp := map[string]any{"status": polled.Status}
	if polled.Status == wechat.QRStatusConfirmed && polled.Installation.ID.Valid {
		resp["installation"] = wechatInstallationToResponse(polled.Installation, wechatQuotaView(h, polled.Installation))
		h.publish(protocol.EventWechatInstallationCreated, uuidToString(polled.Installation.WorkspaceID), "user", userID, map[string]any{
			"id": uuidToString(polled.Installation.ID),
		})
	}
	writeJSON(w, http.StatusOK, resp)
}

// RevokeWechatInstallation (DELETE /api/workspaces/{id}/wechat/installations/{installationId})
func (h *Handler) RevokeWechatInstallation(w http.ResponseWriter, r *http.Request) {
	if h.WechatInstall == nil {
		writeFeatureDisabled(w, "wechat_not_configured", "wechat integration not configured")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	instUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "installationId"), "installation id")
	if !ok {
		return
	}
	if _, err := h.WechatInstall.GetInWorkspace(r.Context(), instUUID, wsUUID); err != nil {
		if errors.Is(err, wechat.ErrInstallationNotFound) {
			writeError(w, http.StatusNotFound, "wechat installation not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load installation")
		return
	}
	if err := h.WechatInstall.Revoke(r.Context(), instUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to revoke installation")
		return
	}
	h.publish(protocol.EventWechatInstallationRevoked, uuidToString(wsUUID), "user", userID, map[string]any{
		"id": uuidToString(instUUID),
	})
	w.WriteHeader(http.StatusNoContent)
}

// RedeemWechatBindingTokenRequest carries the raw token from the bot's bind prompt.
type RedeemWechatBindingTokenRequest struct {
	Token string `json:"token"`
}

// RedeemWechatBindingToken (POST /api/wechat/binding/redeem)
func (h *Handler) RedeemWechatBindingToken(w http.ResponseWriter, r *http.Request) {
	if h.WechatBindingTokens == nil {
		writeFeatureDisabled(w, "wechat_not_configured", "wechat integration not configured")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req RedeemWechatBindingTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Token == "" {
		writeError(w, http.StatusBadRequest, "token is required")
		return
	}
	userUUID, ok := parseUUIDOrBadRequest(w, userID, "user id")
	if !ok {
		return
	}
	redeemed, err := h.WechatBindingTokens.RedeemAndBind(r.Context(), req.Token, userUUID)
	if err != nil {
		switch {
		case errors.Is(err, wechat.ErrBindingTokenInvalid):
			writeError(w, http.StatusGone, "binding token invalid or expired")
		case errors.Is(err, wechat.ErrBindingAlreadyAssigned):
			writeError(w, http.StatusConflict, "this WeChat account is already bound to a different Multica user")
		case errors.Is(err, wechat.ErrBindingNotWorkspaceMember):
			writeError(w, http.StatusForbidden, "binding refused (are you a workspace member?)")
		default:
			writeError(w, http.StatusInternalServerError, "failed to redeem token")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workspace_id":    uuidToString(redeemed.WorkspaceID),
		"installation_id": uuidToString(redeemed.InstallationID),
		"wechat_user_id":  redeemed.WechatUserID,
	})
}
