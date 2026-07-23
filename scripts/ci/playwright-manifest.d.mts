export type RequiredE2EManifestEntry = Readonly<{
  file: string;
  title: string;
}>;

export const REQUIRED_E2E_MANIFEST: readonly RequiredE2EManifestEntry[];
