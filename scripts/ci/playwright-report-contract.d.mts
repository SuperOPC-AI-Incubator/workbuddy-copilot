import type { RequiredE2EManifestEntry } from "./playwright-manifest.mjs";

type NegativeControl = {
  mode: string;
  file: string;
  title: string;
  marker: string;
  diagnosticStages?: readonly string[];
};

export function collectPlaywrightSpecs(report: unknown): Array<Record<string, unknown>>;
export function validateRequiredPlaywrightReport(
  report: unknown,
  manifest: readonly RequiredE2EManifestEntry[],
): void;
export function summarizeNegativeControlFailure(
  report: unknown,
  control: NegativeControl,
): {
  title: string;
  stage: string;
  marker: string;
};
export function validateNegativeControlReport(report: unknown, control: NegativeControl): void;
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
