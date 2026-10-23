package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Asset profiles are workspace-level JSONB documents (portfolio archives and
// similar structured records). The `data` blob is opaque to the server:
// callers own its schema, so it round-trips as raw JSON without decoding.

// maxAssetProfileDataBytes caps the JSONB document size. Matches the per-file
// import cap (maxImportFileSize) — a profile is document-sized, not
// attachment-sized.
const maxAssetProfileDataBytes = 1 << 20 // 1 MiB

type AssetProfileResponse struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspace_id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Data        json.RawMessage `json:"data"`
	CreatedBy   string          `json:"created_by,omitempty"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
}

// AssetProfileSummaryResponse omits `data` for list payloads; profiles are
// read whole, and list views never need the (potentially large) document.
type AssetProfileSummaryResponse struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	CreatedBy   string `json:"created_by,omitempty"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type CreateAssetProfileRequest struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Data        json.RawMessage `json:"data"`
}

type UpdateAssetProfileRequest struct {
	Name        *string         `json:"name"`
	Description *string         `json:"description"`
	Data        json.RawMessage `json:"data"`
}

func assetProfileToResponse(p db.AssetProfile) AssetProfileResponse {
	data := json.RawMessage(p.Data)
	if len(data) == 0 {
		data = json.RawMessage("{}")
	}
	return AssetProfileResponse{
		ID:          uuidToString(p.ID),
		WorkspaceID: uuidToString(p.WorkspaceID),
		Name:        p.Name,
		Description: p.Description,
		Data:        data,
		CreatedBy:   uuidToString(p.CreatedBy),
		CreatedAt:   timestampToString(p.CreatedAt),
		UpdatedAt:   timestampToString(p.UpdatedAt),
	}
}

func assetProfileSummaryToResponse(id, workspaceID, name, description, createdBy, createdAt, updatedAt string) AssetProfileSummaryResponse {
	return AssetProfileSummaryResponse{
		ID:          id,
		WorkspaceID: workspaceID,
		Name:        name,
		Description: description,
		CreatedBy:   createdBy,
		CreatedAt:   createdAt,
		UpdatedAt:   updatedAt,
	}
}

// validateAssetProfileData validates a caller-supplied JSON document: it
// must be an object within the size cap. Returns the bytes ready for storage
// (nil when absent — callers treat that as "don't update" / "default {}").
func validateAssetProfileData(w http.ResponseWriter, raw json.RawMessage) (json.RawMessage, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, true
	}
	if len(raw) > maxAssetProfileDataBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "data exceeds 1 MiB limit")
		return nil, false
	}
	var probe any
	if err := json.Unmarshal(raw, &probe); err != nil {
		writeError(w, http.StatusBadRequest, "data must be valid JSON")
		return nil, false
	}
	if _, ok := probe.(map[string]any); !ok {
		writeError(w, http.StatusBadRequest, "data must be a JSON object")
		return nil, false
	}
	return raw, true
}

// loadAssetProfileForUser resolves an asset profile ID within the request's
// workspace. Membership is checked by callers; the workspace filter here is
// the tenant guard.
func (h *Handler) loadAssetProfileForUser(w http.ResponseWriter, r *http.Request, id string) (db.AssetProfile, bool) {
	workspaceID := h.resolveWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace_id is required")
		return db.AssetProfile{}, false
	}

	profileUUID, ok := parseUUIDOrBadRequest(w, id, "asset profile id")
	if !ok {
		return db.AssetProfile{}, false
	}

	profile, err := h.Queries.GetAssetProfile(r.Context(), db.GetAssetProfileParams{
		ID:          profileUUID,
		WorkspaceID: parseUUID(workspaceID),
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "asset profile not found")
		return profile, false
	}
	return profile, true
}

// --- Asset profile CRUD ---

func (h *Handler) ListAssetProfiles(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceRole(w, r, workspaceID, "asset profiles not found", "owner", "admin", "member"); !ok {
		return
	}
	wsUUID := parseUUID(workspaceID)

	profiles, err := h.Queries.ListAssetProfilesByWorkspace(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("list asset profiles failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list asset profiles")
		return
	}

	resp := make([]AssetProfileSummaryResponse, len(profiles))
	for i, p := range profiles {
		resp[i] = assetProfileSummaryToResponse(
			uuidToString(p.ID), uuidToString(p.WorkspaceID), p.Name, p.Description,
			uuidToString(p.CreatedBy), timestampToString(p.CreatedAt), timestampToString(p.UpdatedAt),
		)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) CreateAssetProfile(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)

	creatorID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceRole(w, r, workspaceID, "asset profiles not found", "owner", "admin", "member"); !ok {
		return
	}
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}
	creatorUUID := parseUUID(creatorID)

	var req CreateAssetProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	data, ok := validateAssetProfileData(w, req.Data)
	if !ok {
		return
	}
	if data == nil {
		data = json.RawMessage("{}")
	}

	profile, err := h.Queries.CreateAssetProfile(r.Context(), db.CreateAssetProfileParams{
		WorkspaceID: workspaceUUID,
		Name:        sanitizeNullBytes(req.Name),
		Description: sanitizeNullBytes(req.Description),
		Data:        data,
		CreatedBy:   creatorUUID,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "an asset profile with this name already exists")
			return
		}
		slog.Warn("create asset profile failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create asset profile")
		return
	}

	resp := assetProfileToResponse(profile)
	actorType, actorID := h.resolveActor(r, creatorID, workspaceID)
	h.publish(protocol.EventAssetProfileCreated, workspaceID, actorType, actorID, map[string]any{"asset_profile": resp})
	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) GetAssetProfile(w http.ResponseWriter, r *http.Request) {
	profile, ok := h.loadAssetProfileForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceRole(w, r, uuidToString(profile.WorkspaceID), "asset profile not found", "owner", "admin", "member"); !ok {
		return
	}
	writeJSON(w, http.StatusOK, assetProfileToResponse(profile))
}

func (h *Handler) UpdateAssetProfile(w http.ResponseWriter, r *http.Request) {
	profile, ok := h.loadAssetProfileForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceRole(w, r, uuidToString(profile.WorkspaceID), "asset profile not found", "owner", "admin", "member"); !ok {
		return
	}

	var req UpdateAssetProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	params := db.UpdateAssetProfileParams{
		ID:          profile.ID,
		WorkspaceID: profile.WorkspaceID,
	}
	if req.Name != nil {
		if *req.Name == "" {
			writeError(w, http.StatusBadRequest, "name cannot be empty")
			return
		}
		params.Name = pgtype.Text{String: sanitizeNullBytes(*req.Name), Valid: true}
	}
	if req.Description != nil {
		params.Description = pgtype.Text{String: sanitizeNullBytes(*req.Description), Valid: true}
	}
	if req.Data != nil {
		data, ok := validateAssetProfileData(w, req.Data)
		if !ok {
			return
		}
		params.Data = data
	}

	profile, err := h.Queries.UpdateAssetProfile(r.Context(), params)
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "an asset profile with this name already exists")
			return
		}
		slog.Warn("update asset profile failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update asset profile")
		return
	}

	wsID := uuidToString(profile.WorkspaceID)
	resp := assetProfileToResponse(profile)
	actorType, actorID := h.resolveActor(r, requestUserID(r), wsID)
	h.publish(protocol.EventAssetProfileUpdated, wsID, actorType, actorID, map[string]any{"asset_profile": resp})
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) DeleteAssetProfile(w http.ResponseWriter, r *http.Request) {
	profile, ok := h.loadAssetProfileForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceRole(w, r, uuidToString(profile.WorkspaceID), "asset profile not found", "owner", "admin", "member"); !ok {
		return
	}

	if err := h.Queries.DeleteAssetProfile(r.Context(), db.DeleteAssetProfileParams{
		ID:          profile.ID,
		WorkspaceID: profile.WorkspaceID,
	}); err != nil {
		slog.Warn("delete asset profile failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete asset profile")
		return
	}

	wsID := uuidToString(profile.WorkspaceID)
	actorType, actorID := h.resolveActor(r, requestUserID(r), wsID)
	h.publish(protocol.EventAssetProfileDeleted, wsID, actorType, actorID, map[string]any{"asset_profile_id": uuidToString(profile.ID)})
	w.WriteHeader(http.StatusNoContent)
}
