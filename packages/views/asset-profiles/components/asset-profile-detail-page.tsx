"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, Check, Copy, Pencil, Trash2 } from "lucide-react";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  assetProfileDetailOptions,
  workspaceKeys,
} from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
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
import { useNavigation } from "../../navigation";
import { PageHeader } from "../../layout/page-header";
import { CollectionPageState } from "../../layout/collection-page";
import { useT } from "../../i18n";
import { AssetProfileDialog } from "./asset-profile-dialog";

/**
 * Asset profile detail: metadata plus the raw JSON document. The document is
 * opaque by contract, so it renders pretty-printed rather than through a
 * schema-specific viewer — any profile is displayable without code changes.
 */
export function AssetProfileDetailPage({ profileId }: { profileId: string }) {
  const { t } = useT("assets");
  const { t: tCommon } = useT("common");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const qc = useQueryClient();
  const { push } = useNavigation();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: profile, isLoading, isError } = useQuery({
    ...assetProfileDetailOptions(wsId, profileId),
    enabled: !!wsId && !!profileId,
    retry: false,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteAssetProfile(profileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspaceKeys.assetProfiles(wsId) });
      push(paths.assets());
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader>
          <Skeleton className="h-5 w-48" />
        </PageHeader>
        <div className="flex-1 space-y-3 p-6">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !profile) {
    return (
      <CollectionPageState
        icon={Archive}
        title={t(($) => $.detail.not_found)}
        tone="destructive"
      />
    );
  }

  const copyDocument = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(profile.data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied or unavailable; the document is still
      // selectable text — nothing further to do.
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        leading={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t(($) => $.detail.back)}
            onClick={() => push(paths.assets())}
          >
            <ArrowLeft />
          </Button>
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Archive aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-body font-medium">{profile.name}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil />
            {t(($) => $.detail.edit)}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmingDelete(true)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 />
            {t(($) => $.detail.delete)}
          </Button>
        </div>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-4">
          {profile.description ? (
            <p className="text-caption text-muted-foreground">
              {profile.description}
            </p>
          ) : null}
          <div className="mt-4 flex items-center justify-between gap-2">
            <h2 className="text-title-sm font-medium">
              {t(($) => $.detail.document)}
            </h2>
            <Button size="sm" variant="ghost" onClick={copyDocument}>
              {copied ? <Check /> : <Copy />}
              {copied ? t(($) => $.detail.copied) : t(($) => $.detail.copy)}
            </Button>
          </div>
          <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-caption leading-relaxed">
            {JSON.stringify(profile.data, null, 2)}
          </pre>
        </div>
      </div>
      {editing ? (
        <AssetProfileDialog
          wsId={wsId}
          profile={profile}
          onClose={() => setEditing(false)}
        />
      ) : null}
      <AlertDialog
        open={confirmingDelete}
        onOpenChange={(v) => !v && setConfirmingDelete(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.detail.delete_confirm_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.detail.delete_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon(($) => $.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
            >
              {t(($) => $.detail.delete)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
