import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Query key namespace for personal WeChat bindings. Realtime sync
 * invalidates `installations(wsId)` on `wechat_installation:*` events so the
 * Settings panel updates when another tab finishes a QR bind or unbind.
 */
export const wechatKeys = {
  all: (wsId: string) => ["wechat", wsId] as const,
  installations: (wsId: string) => [...wechatKeys.all(wsId), "installations"] as const,
  bindStatus: (wsId: string, qrcode: string) =>
    [...wechatKeys.all(wsId), "bind", qrcode] as const,
};

export const wechatInstallationsOptions = (wsId: string) =>
  queryOptions({
    queryKey: wechatKeys.installations(wsId),
    queryFn: () => api.listWechatInstallations(wsId),
    enabled: !!wsId,
  });

const TERMINAL_QR = new Set([
  "confirmed",
  "expired",
  "verify_code_blocked",
  "binded_redirect",
]);

export const wechatBindStatusOptions = (
  wsId: string,
  qrcode: string,
  verifyCode = "",
) =>
  queryOptions({
    queryKey: wechatKeys.bindStatus(wsId, qrcode),
    queryFn: () => api.pollWechatBindStatus(wsId, qrcode, verifyCode || undefined),
    enabled: !!wsId && !!qrcode,
    refetchInterval: (query) => {
      const status = query.state.data?.status ?? "";
      return TERMINAL_QR.has(status) ? false : 2000;
    },
  });
