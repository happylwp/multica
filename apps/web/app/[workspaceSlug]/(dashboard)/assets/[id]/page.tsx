"use client";

import { use } from "react";
import { AssetProfileDetailPage } from "@multica/views/asset-profiles";

export default function AssetProfileDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <AssetProfileDetailPage profileId={id} />;
}
