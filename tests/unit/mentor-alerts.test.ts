import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { getMentorAlertKind } from "@/lib/mentor-alerts";

describe("mentor alerts", () => {
  test("keeps SOS alerts ahead of error diagnosis alerts", () => {
    expect(
      getMentorAlertKind({ kind: "diagnosis", severity: "error", tag: "呼叫导师 · 请协助" }),
    ).toBe("sos");
  });

  test("keeps error and warning diagnosis alerts distinct", () => {
    expect(getMentorAlertKind({ kind: "diagnosis", severity: "error", tag: null })).toBe("error");
    expect(getMentorAlertKind({ kind: "diagnosis", severity: "warn", tag: "WB" })).toBe("warn");
  });

  test("does not convert ordinary timeline events into mentor alerts", () => {
    expect(getMentorAlertKind({ kind: "mentor", severity: null, tag: null })).toBeNull();
    expect(getMentorAlertKind({ kind: "diagnosis", severity: "ok", tag: null })).toBeNull();
  });

  test("keeps the existing mentor subscription wired to the tested alert classification", () => {
    const desk = readFileSync(
      resolve(process.cwd(), "src/routes/_authenticated/index.tsx"),
      "utf8",
    );

    expect(desk).toContain('channel("mentor-alerts")');
    expect(desk).toContain("getMentorAlertKind(row)");
    expect(desk).toContain("new Notification(title");
  });
});
