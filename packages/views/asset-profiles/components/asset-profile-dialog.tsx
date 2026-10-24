"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { workspaceKeys } from "@multica/core/workspace/queries";
import type { AssetProfile } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Label } from "@multica/ui/components/ui/label";
import { useT } from "../../i18n";

/**
 * Create / edit form for an asset profile. The JSON document is validated
 * client-side (must parse as an object) before submit so the user gets the
 * error inline instead of a server 400 after the dialog has closed.
 */
export function AssetProfileDialog({
  wsId,
  profile,
  onClose,
}: {
  wsId: string;
  /** null = create; otherwise edit in place. */
  profile: AssetProfile | null;
  onClose: () => void;
}) {
  const { t } = useT("assets");
  const { t: tCommon } = useT("common");
  const qc = useQueryClient();

  const [name, setName] = useState(profile?.name ?? "");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [dataText, setDataText] = useState(
    profile ? JSON.stringify(profile.data, null, 2) : "",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(profile?.name ?? "");
    setDescription(profile?.description ?? "");
    setDataText(profile ? JSON.stringify(profile.data, null, 2) : "");
    setError(null);
  }, [profile]);

  const mutation = useMutation({
    mutationFn: async () => {
      // Empty textarea keeps the stored document (create sends {}).
      let data: Record<string, unknown> | undefined;
      if (dataText.trim() !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(dataText);
        } catch {
          throw new Error(t(($) => $.dialog.invalid_json));
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error(t(($) => $.dialog.not_object));
        }
        data = parsed as Record<string, unknown>;
      } else if (!profile) {
        data = {};
      }
      if (profile) {
        return api.updateAssetProfile(profile.id, {
          name,
          description,
          ...(data !== undefined ? { data } : {}),
        });
      }
      return api.createAssetProfile({ name, description, data });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspaceKeys.assetProfiles(wsId) });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const submitting = mutation.isPending;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center border-b px-5 pt-4 pb-3">
          <DialogTitle className="truncate text-title-sm font-medium">
            {profile
              ? t(($) => $.dialog.edit_title)
              : t(($) => $.dialog.create_title)}
          </DialogTitle>
        </div>
        <form
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            mutation.mutate();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="asset-profile-name">{t(($) => $.dialog.name)}</Label>
            <Input
              id="asset-profile-name"
              value={name}
              required
              maxLength={200}
              placeholder={t(($) => $.dialog.name_placeholder)}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="asset-profile-description">
              {t(($) => $.dialog.description)}
            </Label>
            <Input
              id="asset-profile-description"
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid min-h-0 flex-1 gap-2">
            <Label htmlFor="asset-profile-data">{t(($) => $.dialog.data)}</Label>
            <Textarea
              id="asset-profile-data"
              value={dataText}
              spellCheck={false}
              placeholder={t(($) => $.dialog.data_placeholder)}
              className="min-h-48 font-mono text-caption"
              onChange={(e) => setDataText(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-caption text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="border-t pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              {tCommon(($) => $.cancel)}
            </Button>
            <Button type="submit" size="sm" disabled={submitting || name.trim() === ""}>
              {submitting
                ? t(($) => $.dialog.saving)
                : profile
                  ? t(($) => $.detail.edit)
                  : t(($) => $.dialog.save)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
