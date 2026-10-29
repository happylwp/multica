"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, MotionConfig } from "motion/react";
import { Archive, Plus } from "@multica/ui/icons";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { assetProfileListOptions } from "@multica/core/workspace/queries";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@multica/ui/components/ui/card";
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
 * Asset profile list, rendered as a card grid that rises into place.
 * Summaries only — `data` never ships in the list payload (server-side
 * design), so cards stay light no matter how large the documents are.
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
    <MotionConfig reducedMotion="user">
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
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
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
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {profiles.map((p, i) => (
              <motion.div
                key={p.id}
                className="h-full"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.05, 0.3), duration: 0.3, ease: "easeOut" }}
                whileHover={{ y: -2 }}
              >
                <Card
                  size="sm"
                  className="h-full"
                  {...rowLink(paths.assetProfileDetail(p.id), p.name)}
                >
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Archive
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">{p.name}</span>
                    </CardTitle>
                    <CardDescription className="line-clamp-2">
                      {p.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <span className="text-caption text-muted-foreground">
                      {p.updated_at ? timeAgo(p.updated_at) : ""}
                    </span>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        )}
        {creating ? (
          <AssetProfileDialog wsId={wsId} profile={null} onClose={() => setCreating(false)} />
        ) : null}
      </div>
    </MotionConfig>
  );
}
