import type { Severity, TimelineKind } from "@/lib/timeline-meta";

export type MentorAlertKind = "sos" | "error" | "warn";

export function getMentorAlertKind({
  kind,
  severity,
  tag,
}: {
  kind: TimelineKind;
  severity: Severity | null;
  tag: string | null;
}): MentorAlertKind | null {
  const tagText = tag ?? "";
  const isSos = tagText.includes("呼叫导师");
  if (isSos) return "sos";
  if (kind === "diagnosis" && severity === "error") return "error";
  if (kind === "diagnosis" && severity === "warn") return "warn";
  return null;
}
