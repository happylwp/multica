"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, Plus } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { assetProfileListOptions } from "@multica/core/workspace/queries";
import {
  ListGrid,
  ListGridBody,
  ListGridCell,
  ListGridHeader,
  ListGridHeaderCell,
  ListGridRow,
} from "@multica/ui/components/ui/list-grid";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Button } from "@multica/ui/components/ui/button";
import { useRowLink } from "../../navigation";
import {
  CollectionPageHeader,
  CollectionPageState,
} from "../../layout/collection-page";
import { useT, useTimeAgo } from "../../i18n";
import { AssetProfileDialog } from "./asset-profile-dialog";

/**
 * Asset profile list. Summaries only — `data` never ships in the list
 * payload (server-side design), so rows are light no matter how large the
 * documents are.
 */
export function AssetProfilesPage() {
  const { t } = useT("assets");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const rowLink = useRowLink();
  const timeAgo = useTimeAgo();

  const [creating, setCreating] = useState(false);

  const { data: profiles, isLoading, isError } = useQuery({
    ...assetProfileListOptions(wsId),
    enabled: !!wsId,
  });

  if (isError) {
    return (
      <CollectionPageState
        icon={Archive}
        title={t(($) => $.detail.not_found)}
        tone="destructive"
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <CollectionPageHeader
        icon={Archive}
        title={t(($) => $.page.title)}
        count={profiles?.length}
        description={t(($) => $.page.description)}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {t(($) => $.page.new_button)}
          </Button>
        }
      />
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : !profiles || profiles.length === 0 ? (
        <CollectionPageState
          icon={Archive}
          title={t(($) => $.page.empty_title)}
          description={t(($) => $.page.empty_description)}
          actions={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              {t(($) => $.page.new_button)}
            </Button>
          }
        />
      ) : (
        <ListGrid>
          <ListGridHeader>
            <ListGridHeaderCell className="w-2/5">
              {t(($) => $.page.table.name)}
            </ListGridHeaderCell>
            <ListGridHeaderCell className="w-2/5">
              {t(($) => $.page.table.description)}
            </ListGridHeaderCell>
            <ListGridHeaderCell className="w-1/5 justify-end">
              {t(($) => $.page.table.updated)}
            </ListGridHeaderCell>
          </ListGridHeader>
          <ListGridBody>
            {profiles.map((p) => (
              <ListGridRow
                key={p.id}
                {...rowLink(paths.assetProfileDetail(p.id), p.name)}
              >
                <ListGridCell className="font-medium">
                  <span className="truncate">{p.name}</span>
                </ListGridCell>
                <ListGridCell className="text-muted-foreground">
                  <span className="truncate">{p.description}</span>
                </ListGridCell>
                <ListGridCell className="justify-end text-muted-foreground">
                  {p.updated_at ? timeAgo(p.updated_at) : ""}
                </ListGridCell>
              </ListGridRow>
            ))}
          </ListGridBody>
        </ListGrid>
      )}
      {creating ? (
        <AssetProfileDialog wsId={wsId} profile={null} onClose={() => setCreating(false)} />
      ) : null}
    </div>
  );
}
