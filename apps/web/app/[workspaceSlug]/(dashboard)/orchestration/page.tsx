"use client";

import { OrchestrationPage } from "@multica/views/orchestration";
import { ErrorBoundary } from "@multica/ui/components/common/error-boundary";

export default function Page() {
  return (
    <ErrorBoundary>
      <OrchestrationPage />
    </ErrorBoundary>
  );
}
