import { extensionToLanguage } from "../editor/utils/preview";

export function languageForDiffPath(path: string): string | undefined {
  return extensionToLanguage(path);
}
