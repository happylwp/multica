"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, Trash2 } from "lucide-react";
import { WechatMark } from "./wechat-mark";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  wechatBindStatusOptions,
  wechatInstallationsOptions,
  wechatKeys,
} from "@multica/core/wechat";
import { api } from "@multica/core/api";
import type { WechatBindQrcode, WechatInstallation } from "@multica/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { useLocale, useT } from "../../i18n";

const QUOTA_LIMIT = 10;

export function qrcodeImageSrc(
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

function isAllowedQrSrc(raw: string): boolean {
  return raw.startsWith("https:") || raw.startsWith("data:image/");
}

function isBoundStatus(status: string): boolean {
  return status === "confirmed" || status === "binded_redirect";
}

// WechatTab is the workspace settings panel for personal WeChat (iLink /
// ClawBot) bindings. Listing is member-visible; bind and unbind are
// admin-only. Bind starts a QR session for a chosen agent — the backend
// requires agent_id on POST /wechat/qrcode.
export function WechatTab() {
  const { t } = useT("settings");
  const locale = useLocale();
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: agents = [] } = useQuery({
    ...agentListOptions(wsId),
    enabled: !!wsId,
  });
  const currentMember = members.find((m) => m.user_id === user?.id) ?? null;
  const canManage =
    currentMember?.role === "owner" || currentMember?.role === "admin";
  const liveAgents = agents.filter((agent) => !agent.archived_at);

  const { data, isLoading, isError } = useQuery({
    ...wechatInstallationsOptions(wsId),
    enabled: !!wsId,
  });
  const installations = data?.installations ?? [];
  const configured = data?.configured === true;
  const installSupported = data?.install_supported === true;
  const hasActive = installations.some((inst) => inst.status === "active");

  const [agentId, setAgentId] = useState("");
  const [session, setSession] = useState<WechatBindQrcode | null>(null);
  const [starting, setStarting] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleStartBind() {
    if (starting || !wsId || !agentId) return;
    setStarting(true);
    try {
      const qr = await api.createWechatBindQrcode(wsId, { agent_id: agentId });
      if (!qr.qrcode) {
        throw new Error(t(($) => $.wechat.bind_start_failed));
      }
      setSession(qr);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t(($) => $.wechat.bind_start_failed),
      );
    } finally {
      setStarting(false);
    }
  }

  async function handleDisconnect() {
    if (!disconnectTarget || disconnecting) return;
    setDisconnecting(true);
    try {
      await api.deleteWechatInstallation(wsId, disconnectTarget);
      await qc.invalidateQueries({ queryKey: wechatKeys.installations(wsId) });
      toast.success(t(($) => $.wechat.toast_disconnected));
      setDisconnectTarget(null);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t(($) => $.wechat.toast_disconnect_failed),
      );
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="space-y-8">
      {isError ? (
        <Card>
          <CardContent>
            <p className="text-body text-muted-foreground">
              {t(($) => $.wechat.load_failed)}
            </p>
          </CardContent>
        </Card>
      ) : !configured ? (
        <Card>
          <CardContent className="space-y-2">
            <p className="text-body font-medium">{t(($) => $.wechat.not_enabled_title)}</p>
            <p className="text-caption text-muted-foreground">
              {t(($) => $.wechat.not_enabled_description_prefix)}{" "}
              <code className="rounded-xs bg-muted px-1 py-0.5 text-micro">
                MULTICA_WECHAT_SECRET_KEY
              </code>{" "}
              {t(($) => $.wechat.not_enabled_description_suffix)}{" "}
              {t(($) => $.wechat.not_enabled_self_host_hint)}
            </p>
          </CardContent>
        </Card>
      ) : !installSupported && installations.length === 0 ? (
        <Card>
          <CardContent className="space-y-2">
            <p className="text-body font-medium">{t(($) => $.wechat.preview_title)}</p>
            <p className="text-caption text-muted-foreground">
              {t(($) => $.wechat.preview_description)}
            </p>
          </CardContent>
        </Card>
      ) : (
        <section className="space-y-3">
          <h2 className="text-body font-semibold">{t(($) => $.wechat.connected_accounts)}</h2>
          {isLoading ? (
            <Card>
              <CardContent>
                <p className="text-body text-muted-foreground">{t(($) => $.wechat.loading)}</p>
              </CardContent>
            </Card>
          ) : session ? (
            <BindQrCard
              qr={session}
              onBound={() => setSession(null)}
              onRefresh={() => void handleStartBind()}
              refreshing={starting}
            />
          ) : (
            <>
              {installations.length === 0 ? (
                <Card>
                  <CardContent className="space-y-3">
                    <p className="text-body font-medium">{t(($) => $.wechat.empty_title)}</p>
                    <p className="text-caption text-muted-foreground">
                      {t(($) => $.wechat.empty_description)}
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="divide-y">
                    {installations.map((inst) => (
                      <InstallationRow
                        key={inst.id}
                        installation={inst}
                        canManage={canManage}
                        locale={locale}
                        onDisconnect={() => setDisconnectTarget(inst.id)}
                      />
                    ))}
                  </CardContent>
                </Card>
              )}
              {canManage && installSupported && !hasActive && (
                <Card>
                  <CardContent className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="wechat-agent-pick">
                        {t(($) => $.wechat.pick_agent_label)}
                      </Label>
                      <select
                        id="wechat-agent-pick"
                        data-testid="wechat-agent-pick"
                        value={agentId}
                        onChange={(e) => setAgentId(e.target.value)}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-body"
                      >
                        <option value="">{t(($) => $.wechat.pick_agent_placeholder)}</option>
                        {liveAgents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name || agent.id}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => void handleStartBind()}
                      disabled={starting || !agentId}
                      data-testid="wechat-bind-start"
                    >
                      <WechatMark className="h-3 w-3" />
                      {starting ? t(($) => $.wechat.qr_refreshing) : t(($) => $.wechat.empty_cta)}
                    </Button>
                  </CardContent>
                </Card>
              )}
            </>
          )}
          {canManage && hasActive && !session && installSupported && (
            <p className="text-caption text-muted-foreground">{t(($) => $.wechat.plugin_hint)}</p>
          )}
        </section>
      )}

      <AlertDialog
        open={!!disconnectTarget}
        onOpenChange={(v) => {
          if (!v && !disconnecting) setDisconnectTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.wechat.disconnect_confirm_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.wechat.disconnect_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>
              {t(($) => $.wechat.disconnect_confirm_cancel)}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting
                ? t(($) => $.wechat.disconnecting)
                : t(($) => $.wechat.disconnect)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function InstallationRow({
  installation,
  canManage,
  locale,
  onDisconnect,
}: {
  installation: WechatInstallation;
  canManage: boolean;
  locale: string;
  onDisconnect: () => void;
}) {
  const { t } = useT("settings");
  const { getAgentName } = useActorName();
  const isActive = installation.status === "active";
  const nickname = installation.nickname || t(($) => $.wechat.nickname_unknown);
  const agentName = installation.agent_id ? getAgentName(installation.agent_id) : "";
  return (
    <div
      className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
      data-testid="wechat-installation-row"
    >
      <div className="flex items-start gap-3">
        {installation.agent_id ? (
          <ActorAvatar
            actorType="agent"
            actorId={installation.agent_id}
            size="lg"
            enableHoverCard
            profileLink
          />
        ) : (
          <span className="flex size-10 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
            <WechatMark className="h-4 w-4" />
          </span>
        )}
        <div className="space-y-1">
          <p className="text-body font-medium">
            {t(($) => $.wechat.nickname_label, { nickname })}
            {!isActive && (
              <span className="ml-2 rounded-xs bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
                {t(($) => $.wechat.revoked_badge)}
              </span>
            )}
          </p>
          {agentName ? (
            <p className="text-micro text-muted-foreground">{agentName}</p>
          ) : null}
          {isActive && <QuotaAndWindow installation={installation} locale={locale} />}
        </div>
      </div>
      {canManage && isActive && (
        <Button variant="outline" size="sm" onClick={onDisconnect}>
          <Trash2 className="h-3 w-3" />
          {t(($) => $.wechat.disconnect)}
        </Button>
      )}
    </div>
  );
}

function QuotaAndWindow({
  installation,
  locale,
}: {
  installation: WechatInstallation;
  locale: string;
}) {
  const { t } = useT("settings");
  const quota = t(($) => $.wechat.quota_label, {
    remaining: String(installation.remaining_quota),
    limit: String(QUOTA_LIMIT),
  });
  const windowLabel = installation.window_valid
    ? t(($) => $.wechat.window_active)
    : t(($) => $.wechat.window_inactive);
  const expires =
    installation.window_expires_at && installation.window_valid
      ? t(($) => $.wechat.window_expires, {
          when: new Date(installation.window_expires_at).toLocaleString(locale),
        })
      : null;
  return (
    <div className="space-y-0.5" data-testid="wechat-quota-window">
      <p className="text-micro text-muted-foreground">{quota}</p>
      <p className="text-micro text-muted-foreground">
        {windowLabel}
        {expires ? ` · ${expires}` : ""}
      </p>
    </div>
  );
}

function BindQrCard({
  qr,
  onBound,
  onRefresh,
  refreshing,
}: {
  qr: WechatBindQrcode;
  onBound: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [verifyCode, setVerifyCode] = useState("");
  const [submittedVerify, setSubmittedVerify] = useState("");
  const [imgFailed, setImgFailed] = useState(false);
  const { data } = useQuery({
    ...wechatBindStatusOptions(wsId, qr.qrcode, submittedVerify),
    enabled: !!wsId && !!qr.qrcode,
  });
  const status = data?.status ?? "wait";
  const src = qrcodeImageSrc(qr);
  const boundOnce = useRef(false);

  useEffect(() => {
    setImgFailed(false);
  }, [qr.qrcode, src]);

  useEffect(() => {
    if (!isBoundStatus(status) || boundOnce.current) return;
    boundOnce.current = true;
    void qc.invalidateQueries({ queryKey: wechatKeys.installations(wsId) });
    toast.success(t(($) => $.wechat.status_bound));
    onBound();
  }, [onBound, qc, status, t, wsId]);

  const imageBroken = imgFailed || Boolean(qr.error);
  const showRetry =
    status === "expired" ||
    status === "verify_code_blocked" ||
    imageBroken ||
    !src;

  const statusLabel = imageBroken
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
    <Card>
      <CardContent className="space-y-3" data-testid="wechat-bind-qr-card">
        <p className="text-body font-medium">{t(($) => $.wechat.qr_title)}</p>
        <p className="text-caption text-muted-foreground">{t(($) => $.wechat.qr_hint)}</p>
        <div className="flex flex-col items-center gap-3">
          {src && !imageBroken ? (
            <img
              src={src}
              alt=""
              className="size-48 rounded-md border bg-white p-2"
              data-testid="wechat-bind-qr"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div
              className="flex size-48 items-center justify-center rounded-md border bg-muted text-caption text-muted-foreground"
              data-testid={imageBroken ? "wechat-bind-qr-failed" : "wechat-bind-qr-missing"}
            >
              {imageBroken ? null : t(($) => $.wechat.qr_missing)}
            </div>
          )}
          <p className="text-caption font-medium" data-testid="wechat-bind-status">
            {statusLabel}
          </p>
        </div>
        {status === "need_verifycode" && (
          <div className="space-y-1.5">
            <Label htmlFor="wechat-verify-code">{t(($) => $.wechat.verify_code_label)}</Label>
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
        {showRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            data-testid="wechat-qr-refresh"
          >
            {refreshing ? t(($) => $.wechat.qr_refreshing) : t(($) => $.wechat.qr_refresh)}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function WechatAgentBindButton({
  agentId,
  agentName,
  className,
  onShowConnectedDetails,
}: {
  agentId: string;
  agentName?: string;
  className?: string;
  onShowConnectedDetails?: () => void;
}) {
  const { t } = useT("settings");
  const locale = useLocale();
  const wsId = useWorkspaceId();
  const user = useAuthStore((s) => s.user);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [session, setSession] = useState<WechatBindQrcode | null>(null);
  const [starting, setStarting] = useState(false);

  const { data: listing } = useQuery({
    ...wechatInstallationsOptions(wsId),
    enabled: !!wsId,
  });
  const installSupported = listing?.install_supported === true;

  const { data: members = [] } = useQuery({
    ...memberListOptions(wsId),
    enabled: !!wsId,
  });
  const currentMember = members.find((m) => m.user_id === user?.id) ?? null;
  const canManage =
    currentMember?.role === "owner" || currentMember?.role === "admin";

  if (!canManage) return null;

  const existing = listing?.installations.find(
    (inst) => inst.status === "active" && inst.agent_id === agentId,
  );
  if (existing) {
    return onShowConnectedDetails ? (
      <WechatAgentStatusRow onClick={onShowConnectedDetails} className={className} />
    ) : (
      <WechatAgentConnectedBadge
        installation={existing}
        className={className}
        locale={locale}
      />
    );
  }

  if (!installSupported) return null;

  function closeDialog() {
    if (starting) return;
    setDialogOpen(false);
    setSession(null);
  }

  async function handleStart() {
    if (starting || !agentId) return;
    setStarting(true);
    try {
      const qr = await api.createWechatBindQrcode(wsId, { agent_id: agentId });
      if (!qr.qrcode) {
        throw new Error(t(($) => $.wechat.bind_start_failed));
      }
      setSession(qr);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t(($) => $.wechat.bind_start_failed),
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-testid="wechat-agent-bind-buttons"
    >
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setDialogOpen(true);
          void handleStart();
        }}
        disabled={!agentId || starting}
        title={
          agentName
            ? t(($) => $.wechat.bind_button_title, { agent: agentName })
            : undefined
        }
        data-testid="wechat-agent-connect"
      >
        <WechatMark className="h-3 w-3" />
        {t(($) => $.wechat.bind_button)}
      </Button>

      <Dialog
        open={dialogOpen}
        onOpenChange={(v) => (v ? setDialogOpen(true) : closeDialog())}
      >
        <DialogContent className="sm:max-w-lg" data-testid="wechat-bind-dialog">
          <DialogHeader>
            <DialogTitle>{t(($) => $.wechat.qr_title)}</DialogTitle>
          </DialogHeader>
          {session ? (
            <BindQrCard
              qr={session}
              onBound={() => {
                setDialogOpen(false);
                setSession(null);
              }}
              onRefresh={() => void handleStart()}
              refreshing={starting}
            />
          ) : (
            <p className="text-caption text-muted-foreground">
              {starting ? t(($) => $.wechat.loading) : t(($) => $.wechat.qr_hint)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={closeDialog} disabled={starting}>
              {t(($) => $.wechat.disconnect_confirm_cancel)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WechatAgentStatusRow({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  const { t } = useT("settings");
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      data-testid="wechat-agent-bot-status"
    >
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="truncate">{t(($) => $.wechat.agent_bot_connected_label)}</span>
      <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

function WechatAgentConnectedBadge({
  installation,
  className,
  locale,
}: {
  installation: WechatInstallation;
  className?: string;
  locale: string;
}) {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await api.deleteWechatInstallation(wsId, installation.id);
      await qc.invalidateQueries({ queryKey: wechatKeys.installations(wsId) });
      toast.success(t(($) => $.wechat.toast_disconnected));
      setConfirmOpen(false);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t(($) => $.wechat.toast_disconnect_failed),
      );
    } finally {
      setDisconnecting(false);
    }
  }

  const nickname = installation.nickname;
  return (
    <div
      className={cn("space-y-2", className)}
      data-testid="wechat-agent-bot-connected"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
          <span className="truncate">
            {nickname
              ? t(($) => $.wechat.agent_bot_connected_label_with_name, { nickname })
              : t(($) => $.wechat.agent_bot_connected_label)}
          </span>
        </span>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={disconnecting}
          title={t(($) => $.wechat.agent_bot_disconnect_tooltip)}
          aria-label={t(($) => $.wechat.disconnect)}
          data-testid="wechat-agent-bot-disconnect"
        >
          <Trash2 className="h-3 w-3" />
          {disconnecting
            ? t(($) => $.wechat.disconnecting)
            : t(($) => $.wechat.disconnect)}
        </Button>
      </div>
      <QuotaAndWindow installation={installation} locale={locale} />

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(v) => {
          if (!v && !disconnecting) setConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.wechat.disconnect_confirm_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.wechat.disconnect_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>
              {t(($) => $.wechat.disconnect_confirm_cancel)}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting
                ? t(($) => $.wechat.disconnecting)
                : t(($) => $.wechat.disconnect)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
