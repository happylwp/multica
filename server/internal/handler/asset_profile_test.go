package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Asset profiles round-trip a caller-owned JSONB document. The tests below
// cover the full CRUD flow plus the guards: name uniqueness (409), object-only
// data (400), required name (400), and cross-workspace isolation (404).

func TestAssetProfileCRUD(t *testing.T) {
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM asset_profile WHERE workspace_id = $1 AND name LIKE 'crud-%'`, testWorkspaceID)
	})

	// Create — data document must come back byte-equivalent (as JSON).
	w := testutil.Call(t, testHandler.CreateAssetProfile, newRequest("POST", "/api/asset-profiles", map[string]any{
		"name":        "crud-portfolio",
		"description": "test archive",
		"data": map[string]any{
			"funds": []map[string]any{
				{"code": "161716", "shares": 24935.09, "cost_price": 1.587},
			},
			"totals": map[string]any{"market_value": 41175.31},
		},
	})).Want(http.StatusCreated)

	var created AssetProfileResponse
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	if created.ID == "" || created.Name != "crud-portfolio" {
		t.Fatalf("unexpected created profile: %+v", created)
	}
	var data map[string]any
	if err := json.Unmarshal(created.Data, &data); err != nil {
		t.Fatalf("created data not JSON object: %v", err)
	}
	if _, ok := data["funds"]; !ok {
		t.Fatalf("created data missing funds: %s", created.Data)
	}

	// Get — full document included.
	req := withURLParam(newRequest("GET", "/api/asset-profiles/"+created.ID, nil), "id", created.ID)
	w = testutil.Call(t, testHandler.GetAssetProfile, req).Want(http.StatusOK)
	var got AssetProfileResponse
	json.NewDecoder(w.Body).Decode(&got)
	if got.ID != created.ID {
		t.Fatalf("Get returned %s, want %s", got.ID, created.ID)
	}
	if string(got.Data) != string(created.Data) {
		t.Fatalf("Get data %s != created data %s", got.Data, created.Data)
	}

	// List — summaries must omit `data`.
	req = newRequest("GET", "/api/asset-profiles?workspace_id="+testWorkspaceID, nil)
	w = testutil.Call(t, testHandler.ListAssetProfiles, req).Want(http.StatusOK)
	var rows []map[string]any
	json.NewDecoder(w.Body).Decode(&rows)
	found := false
	for _, row := range rows {
		if row["id"] != created.ID {
			continue
		}
		found = true
		if _, ok := row["data"]; ok {
			t.Fatalf("List must omit data, got: %v", row)
		}
	}
	if !found {
		t.Fatalf("List missing created profile %s", created.ID)
	}

	// Update — partial: rename and replace data, keep description.
	req = withURLParam(newRequest("PATCH", "/api/asset-profiles/"+created.ID, map[string]any{
		"name": "crud-portfolio-v2",
		"data": map[string]any{"totals": map[string]any{"market_value": 126558.33}},
	}), "id", created.ID)
	w = testutil.Call(t, testHandler.UpdateAssetProfile, req).Want(http.StatusOK)
	var updated AssetProfileResponse
	json.NewDecoder(w.Body).Decode(&updated)
	if updated.Name != "crud-portfolio-v2" {
		t.Fatalf("Update name: got %q", updated.Name)
	}
	if updated.Description != "test archive" {
		t.Fatalf("Update must keep description, got %q", updated.Description)
	}

	// Delete — then Get returns 404.
	req = withURLParam(newRequest("DELETE", "/api/asset-profiles/"+created.ID, nil), "id", created.ID)
	testutil.Call(t, testHandler.DeleteAssetProfile, req).Want(http.StatusNoContent)
	req = withURLParam(newRequest("GET", "/api/asset-profiles/"+created.ID, nil), "id", created.ID)
	testutil.Call(t, testHandler.GetAssetProfile, req).Want(http.StatusNotFound)
}

func TestCreateAssetProfile_DuplicateNameConflict(t *testing.T) {
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM asset_profile WHERE workspace_id = $1 AND name LIKE 'dup-%'`, testWorkspaceID)
	})

	body := map[string]any{"name": "dup-portfolio", "data": map[string]any{}}
	testutil.Call(t, testHandler.CreateAssetProfile, newRequest("POST", "/api/asset-profiles", body)).Want(http.StatusCreated)
	testutil.Call(t, testHandler.CreateAssetProfile, newRequest("POST", "/api/asset-profiles", body)).Want(http.StatusConflict)
}

func TestCreateAssetProfile_ValidatesNameAndData(t *testing.T) {
	testutil.Call(t, testHandler.CreateAssetProfile,
		newRequest("POST", "/api/asset-profiles", map[string]any{"name": ""})).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.CreateAssetProfile,
		newRequest("POST", "/api/asset-profiles", map[string]any{"name": "bad-1", "data": []string{"not-an-object"}})).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.CreateAssetProfile,
		newRequest("POST", "/api/asset-profiles", map[string]any{"name": "bad-2", "data": "scalar"})).Want(http.StatusBadRequest)
}

func TestAssetProfile_CrossWorkspaceIsolation(t *testing.T) {
	foreignID := insertAssetProfileInForeignWorkspace(t)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM asset_profile WHERE id = $1`, foreignID)
	})

	// Requests scoped to the test workspace must not see the foreign profile.
	req := withURLParam(newRequest("GET", "/api/asset-profiles/"+foreignID, nil), "id", foreignID)
	testutil.Call(t, testHandler.GetAssetProfile, req).Want(http.StatusNotFound)
	req = withURLParam(newRequest("PATCH", "/api/asset-profiles/"+foreignID, map[string]any{"name": "hijack"}), "id", foreignID)
	testutil.Call(t, testHandler.UpdateAssetProfile, req).Want(http.StatusNotFound)
	req = withURLParam(newRequest("DELETE", "/api/asset-profiles/"+foreignID, nil), "id", foreignID)
	testutil.Call(t, testHandler.DeleteAssetProfile, req).Want(http.StatusNotFound)
}

func insertAssetProfileInForeignWorkspace(t *testing.T) string {
	t.Helper()
	slug := "foreign-ap-" + t.Name()
	workspaceID := dbfx.Insert(t, "workspace", testutil.Cols{
		"name":         "Foreign Asset Profile Workspace " + t.Name(),
		"slug":         slug,
		"description":  "",
		"issue_prefix": "FAP",
	})
	return dbfx.Insert(t, "asset_profile", testutil.Cols{
		"workspace_id": workspaceID,
		"name":         "foreign-portfolio-" + t.Name(),
		"description":  "fixture",
		"data":         testutil.Raw(`'{"funds": []}'::jsonb`),
		"created_by":   testUserID,
	})
}

// TestAssetProfileQueriesMatchSchema keeps the sqlc layer honest: the
// workspace + name unique index is the only conflict source the handler maps
// to 409, so a same-workspace insert of an existing name must surface as a
// unique violation (not a silent success).
func TestAssetProfileQueriesMatchSchema(t *testing.T) {
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM asset_profile WHERE workspace_id = $1 AND name = 'schema-check'`, testWorkspaceID)
	})

	wsUUID := parseUUID(testWorkspaceID)
	_, err := testHandler.Queries.CreateAssetProfile(context.Background(), db.CreateAssetProfileParams{
		WorkspaceID: wsUUID,
		Name:        "schema-check",
		Data:        []byte(`{}`),
	})
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	if _, err := testHandler.Queries.CreateAssetProfile(context.Background(), db.CreateAssetProfileParams{
		WorkspaceID: wsUUID,
		Name:        "schema-check",
		Data:        []byte(`{}`),
	}); !isUniqueViolation(err) {
		t.Fatalf("second create: expected unique violation, got %v", err)
	}
}
