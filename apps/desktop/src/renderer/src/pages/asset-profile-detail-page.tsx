import { useParams } from "react-router-dom";
import {
  AssetProfileDetailPage as SharedAssetProfileDetailPage,
} from "@multica/views/asset-profiles";

// Window/tab titles follow the upstream tab title contract (MUL-9772):
// `DocumentTitleSync` resolves them from the URL via `useTabPresentation`
// (`/assets` and `/assets/:id` resolve through the `assets` page segment),
// so this wrapper no longer writes `document.title` itself.
export function AssetProfileDetailPage() {
  const { id } = useParams<{ id: string }>();

  if (!id) return null;
  return <SharedAssetProfileDetailPage profileId={id} />;
}
