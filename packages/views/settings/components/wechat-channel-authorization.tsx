"use client";

// WechatChannelAuthorization — the QR half of binding a personal WeChat
// (iLink / ClawBot) account to an agent, rendered inside ChannelConnectDialog.
// Mirrors WecomChannelAuthorization's shape: mount starts a bind session and
// the dialog closes itself once the bind confirms. The polling stays on
// wechatBindStatusOptions (its refetchInterval encodes the server's own QR
// cadence and expiry), and the verify-code branch is WeChat-specific — iLink
// may demand a secondary code after the scan.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { DialogFooter } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { api } from "@multica/core/api";
import type { WechatBindQrcode } from "@multica/core/types";
import { wechatBindStatusOptions, wechatKeys } from "@multica/core/wechat";
import { useT } from "../../i18n";

function isAllowedQrSrc(raw: string): boolean {
  return raw.startsWith("https:") || raw.startsWith("data:image/");
}

function qrcodeImageSrc(
  qr: Pick<WechatBindQrcode, "qrcode_img_content"> & {
    qrcode_base64?: string;
  },
): string | null {
  const raw = qr.qrcode_img_content || "";
  if (isAllowedQrSrc(raw)) return raw;
  if (qr.qrcode_base64) {
    const encoded = qr.qrcode_base64.startsWith("data:")
      ? qr.qrcode_base64
      : `data:image/png;base64,${qr.qrcode_base64}`;
    if (isAllowedQrSrc(encoded)) return encoded;
  }
  return null;
}

function isBoundStatus(status: string): boolean {
  return status === "confirmed" || status === "binded_redirect";
}

export function WechatChannelAuthorization({
  wsId,
  agentId,
  onClose,
}: {
  wsId: string;
  agentId: string;
  onClose: () => void;
}) {
  const { t } = useT("settings");
  const qc = useQueryClient();

  const [session, setSession] = useState<WechatBindQrcode | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [submittedVerify, setSubmittedVerify] = useState("");
  const [imgFailed, setImgFailed] = useState(false);
  const closedRef = useRef(false);

  const startBind = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setStartFailed(false);
    setSubmittedVerify("");
    try {
      const qr = await api.createWechatBindQrcode(wsId, { agent_id: agentId });
      if (closedRef.current) return;
      if (!qr.qrcode) throw new Error(t(($) => $.wechat.bind_start_failed));
      setSession(qr);
    } catch (e) {
      if (closedRef.current) return;
      setStartFailed(true);
      toast.error(
        e instanceof Error ? e.message : t(($) => $.wechat.bind_start_failed),
      );
    } finally {
      if (!closedRef.current) setStarting(false);
    }
  }, [agentId, starting, t, wsId]);

  // Kick off on mount. closedRef resets at the start of every mount for the
  // same StrictMode reason WecomChannelAuthorization documents.
  useEffect(() => {
    closedRef.current = false;
    void startBind();
    return () => {
      closedRef.current = true;
    };
  }, [startBind]);

  const { data } = useQuery({
    ...wechatBindStatusOptions(wsId, session?.qrcode ?? "", submittedVerify),
    enabled: !!session,
  });
  const status = data?.status ?? "wait";
  const src = session ? qrcodeImageSrc(session) : null;

  useEffect(() => {
    setImgFailed(false);
  }, [session?.qrcode, src]);

  // Close shortly after the bind confirms so the success state is visible.
  useEffect(() => {
    if (!isBoundStatus(status)) return;
    void qc.invalidateQueries({ queryKey: wechatKeys.installations(wsId) });
    toast.success(t(($) => $.wechat.status_bound));
    const timer = setTimeout(onClose, 800);
    return () => clearTimeout(timer);
  }, [onClose, qc, status, t, wsId]);

  const imageBroken = imgFailed || Boolean(session?.error);
  const showRetry =
    starting ||
    startFailed ||
    status === "expired" ||
    status === "verify_code_blocked" ||
    imageBroken ||
    !src;

  const statusLabel = !session
    ? t(($) => $.wechat.loading)
    : imageBroken
      ? t(($) => $.wechat.status_failed)
      : status === "scaned" || status === "scaned_but_redirect"
        ? t(($) => $.wechat.status_scanned)
        : status === "need_verifycode"
          ? t(($) => $.wechat.status_need_verify)
          : status === "expired"
            ? t(($) => $.wechat.status_expired)
            : status === "verify_code_blocked"
              ? t(($) => $.wechat.status_verify_blocked)
              : isBoundStatus(status)
                ? t(($) => $.wechat.status_bound)
                : t(($) => $.wechat.status_pending);

  return (
    <>
      <div className="flex flex-col items-center gap-3 py-2">
        <p className="text-caption text-muted-foreground text-center">
          {t(($) => $.wechat.qr_hint)}
        </p>
        {src && !imageBroken ? (
          // White plate regardless of theme: a QR needs light quiet zones to
          // scan, and the dark-mode surface token would invert it.
          <div className="rounded-md border bg-white p-3">
            <img
              src={src}
              alt=""
              className="size-48"
              data-testid="wechat-bind-qr"
              onError={() => setImgFailed(true)}
            />
          </div>
        ) : (
          <div
            className="flex size-48 items-center justify-center rounded-md border bg-muted text-caption text-muted-foreground"
            data-testid={
              imageBroken ? "wechat-bind-qr-failed" : "wechat-bind-qr-missing"
            }
          >
            {imageBroken ? null : t(($) => $.wechat.qr_missing)}
          </div>
        )}
        <p className="text-caption font-medium" data-testid="wechat-bind-status">
          {statusLabel}
        </p>
        {status === "need_verifycode" && (
          <div className="w-full space-y-1.5">
            <Label htmlFor="wechat-verify-code">
              {t(($) => $.wechat.verify_code_label)}
            </Label>
            <div className="flex gap-2">
              <Input
                id="wechat-verify-code"
                data-testid="wechat-verify-code"
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value)}
                autoComplete="off"
              />
              <Button
                size="sm"
                onClick={() => setSubmittedVerify(verifyCode.trim())}
                disabled={!verifyCode.trim()}
                data-testid="wechat-verify-submit"
              >
                {t(($) => $.wechat.verify_submit)}
              </Button>
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t(($) => $.wechat.disconnect_confirm_cancel)}
        </Button>
        {showRetry ? (
          <Button
            size="sm"
            onClick={() => void startBind()}
            disabled={starting}
            data-testid="wechat-qr-refresh"
          >
            {starting
              ? t(($) => $.wechat.qr_refreshing)
              : t(($) => $.wechat.qr_refresh)}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
