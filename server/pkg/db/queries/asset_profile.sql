-- Asset profile CRUD

-- name: ListAssetProfilesByWorkspace :many
SELECT id, workspace_id, name, description, created_by, created_at, updated_at
FROM asset_profile
WHERE workspace_id = $1
ORDER BY name ASC;

-- name: GetAssetProfile :one
SELECT * FROM asset_profile
WHERE id = $1 AND workspace_id = $2;

-- name: CreateAssetProfile :one
INSERT INTO asset_profile (workspace_id, name, description, data, created_by)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: UpdateAssetProfile :one
UPDATE asset_profile SET
    name = COALESCE(sqlc.narg('name'), name),
    description = COALESCE(sqlc.narg('description'), description),
    data = COALESCE(sqlc.narg('data'), data),
    updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: DeleteAssetProfile :exec
-- Defense-in-depth: workspace_id is a SQL-layer tenant guard. See DeleteIssue.
DELETE FROM asset_profile WHERE id = $1 AND workspace_id = $2;
