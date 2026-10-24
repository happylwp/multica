import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AssetProfileDetailPage as SharedAssetProfileDetailPage,
} from "@multica/views/asset-profiles";
import { useWorkspaceId } from "@multica/core/hooks";
import { assetProfileDetailOptions } from "@multica/core/workspace/queries";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function AssetProfileDetailPage() {
  const { id } = useParams<{ id: string }>();
  const wsId = useWorkspaceId();
  const { data: profile } = useQuery(
    assetProfileDetailOptions(wsId, id ?? ""),
  );

  useDocumentTitle(profile?.name ?? "Asset");

  if (!id) return null;
  return <SharedAssetProfileDetailPage profileId={id} />;
}
