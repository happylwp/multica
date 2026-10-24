// Asset profiles: workspace-level JSONB documents (portfolio archives and
// similar structured records). The server treats `data` as opaque; the client
// mirrors that — it parses the envelope and passes the document through as a
// plain JSON value. No page may assume a schema beyond "it is an object".

export interface AssetProfileSummary {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssetProfile extends AssetProfileSummary {
  data: Record<string, unknown>;
}

export interface CreateAssetProfileRequest {
  name: string;
  description?: string;
  data?: Record<string, unknown>;
}

/**
 * All fields optional like the server's PATCH semantics: omitted keys keep
 * their stored value. An explicit `data` replaces the whole document —
 * partial merges are the caller's responsibility (read-modify-write).
 */
export interface UpdateAssetProfileRequest {
  name?: string;
  description?: string;
  data?: Record<string, unknown>;
}
