/**
 * A personal WeChat (iLink / ClawBot plugin) binding. Wire shape mirrors
 * `WechatInstallationResponse` in `server/internal/handler/wechat.go`.
 *
 *   GET    /api/workspaces/:id/wechat/installations
 *   POST   /api/workspaces/:id/wechat/qrcode?agent_id=
 *   POST   /api/workspaces/:id/wechat/qrcode/status
 *   DELETE /api/workspaces/:id/wechat/installations/:id
 */
export interface WechatInstallation {
  id: string;
  workspace_id: string;
  agent_id: string;
  bot_id: string;
  nickname: string;
  ilink_user_id: string;
  installer_user_id: string;
  status: "active" | "revoked" | string;
  support_markdown: boolean;
  remaining_quota: number;
  window_valid: boolean;
  window_expires_at: string;
  last_inbound_at: string;
  installed_at: string;
  created_at: string;
  updated_at: string;
}

export interface ListWechatInstallationsResponse {
  installations: WechatInstallation[];
  configured: boolean;
  install_supported?: boolean;
}

export interface CreateWechatBindQrcodeRequest {
  agent_id: string;
}

/** POST /wechat/qrcode response. `qrcode` is the session key; the image
 * lives in `qrcode_img_content` (URL or data URL). */
export interface WechatBindQrcode {
  qrcode: string;
  qrcode_img_content: string;
  expires_in: number;
}

/**
 * Official iLink QR statuses. `scaned` / `binded_redirect` are the
 * protocol spellings, not typos — see integrations/wechat/api.go.
 */
export type WechatBindPhase =
  | "wait"
  | "scaned"
  | "need_verifycode"
  | "verify_code_blocked"
  | "expired"
  | "scaned_but_redirect"
  | "binded_redirect"
  | "confirmed"
  | string;

export interface WechatBindStatusResponse {
  status: WechatBindPhase;
  installation?: WechatInstallation;
}

export interface RedeemWechatBindingTokenResponse {
  workspace_id: string;
  installation_id: string;
  wechat_user_id: string;
}
