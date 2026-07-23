import { describe, expect, test, vi } from "vitest";

import { DOMAIN_PACKS, resolveDomainPack, type DomainPackWarningLogger } from "@/lib/domain-packs";
import { aiUnavailableResult } from "@/lib/ai.server";

describe("domain packs", () => {
  test("defaults to the general learning camp without PLC drift", () => {
    const pack = resolveDomainPack(undefined);
    expect(pack.id).toBe("general-learning-camp");
    expect(pack.studentSystemContext).toContain("Pioneers Learning Community");
    expect(pack.studentSystemContext).toContain("学习营地");
    expect(pack.studentSystemContext).not.toMatch(/PLC|梯形图|工业自动化|急停/);
  });

  test("keeps industrial automation as an explicit opt-in pack", () => {
    expect(DOMAIN_PACKS["industrial-automation"].studentSystemContext).toMatch(/PLC|工业自动化/);
    expect(resolveDomainPack("industrial-automation").id).toBe("industrial-automation");
  });

  test("unknown values fail safe with a sanitized warning", () => {
    const logger: DomainPackWarningLogger = { warn: vi.fn() };
    expect(resolveDomainPack("secret-customer-name", logger).id).toBe("general-learning-camp");
    expect(logger.warn).toHaveBeenCalledWith({
      code: "UNKNOWN_DOMAIN_PACK",
      fallback: "general-learning-camp",
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("secret-customer-name");
  });

  test("returns a clear AI-unavailable result without throwing", () => {
    expect(aiUnavailableResult("draft")).toEqual({
      available: false,
      code: "AI_UNAVAILABLE",
      message: "AI草稿暂不可用，人工导师功能不受影响",
      draft: "",
    });
  });
});
