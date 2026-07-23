import type { RequiredE2EManifestEntry } from "./playwright-manifest.mjs";

export function collectPlaywrightSpecs(report: unknown): Array<Record<string, unknown>>;
export function validateRequiredPlaywrightReport(
  report: unknown,
  manifest: readonly RequiredE2EManifestEntry[],
): void;
export function validateNegativeControlReport(
  report: unknown,
  control: {
    mode: string;
    file: string;
    title: string;
    marker: string;
  },
): void;
export function sanitizePlaywrightReport(
  report: unknown,
  manifest: readonly RequiredE2EManifestEntry[],
): Array<{
  file: string;
  title: string;
  status: string;
  count: number;
  duration: number;
}>;
