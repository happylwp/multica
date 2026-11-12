"use client";

// WechatChannelAuthorization — the QR half of connecting a personal WeChat
// (iLink) bot, embedded in ChannelConnectDialog next to the Feishu/WeCom
// authorization panels. Reuses BindQrCard from wechat-tab: binding is a
// polled iLink QR session with its own server-driven cadence and expiry, so
// a fresh session is started on every mount just like the settings-page flow.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import type { WechatBindQrcode } from "@multica/core/types";
import { useT } from "../../i18n";
import { BindQrCard } from "./wechat-tab";

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
  const [session, setSession] = useState<WechatBindQrcode | null>(null);
  const [starting, setStarting] = useState(false);

  const start = useCallback(async () => {
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
  }, [wsId, agentId, t]);

  useEffect(() => {
    void start();
  }, [start]);

  if (!session) {
    return (
      <p className="py-2 text-center text-caption text-muted-foreground">
        {t(($) => $.wechat.loading)}
      </p>
    );
  }
  return (
    <BindQrCard
      qr={session}
      onBound={onClose}
      onRefresh={() => void start()}
      refreshing={starting}
    />
  );
}
