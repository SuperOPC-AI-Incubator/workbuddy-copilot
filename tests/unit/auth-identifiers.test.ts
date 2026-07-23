import { describe, expect, test } from "vitest";

import {
  loginIdentifierToEmail,
  mentorUsernameToEmail,
  normalizeMentorUsername,
} from "@/lib/auth/identifiers";

describe("mentor authentication identifiers", () => {
  test("normalizes MRF to mrf", () => {
    expect(normalizeMentorUsername("  MRF  ")).toBe("mrf");
  });

  test("derives a stable opaque versioned email", () => {
    const email = mentorUsernameToEmail("MRF");

    expect(email).toMatch(/^u1_[A-Za-z0-9_-]{43}@auth\.copilot\.sg\.superbrain-ai\.com$/);
    expect(email).not.toContain("mrf");
  });

  test("keeps the xiuqiang mapping deterministic", () => {
    expect(mentorUsernameToEmail("xiuqiang")).toBe(
      "u1_2OwceekZGh1S-ughniA5jigeGi4oK5fAr4ohokZDU8c@auth.copilot.sg.superbrain-ai.com",
    );
    expect(mentorUsernameToEmail("xiuqiang")).toBe(mentorUsernameToEmail("xiuqiang"));
  });

  test("keeps a normal student email and lowercases it", () => {
    expect(loginIdentifierToEmail("  Student@Example.COM  ")).toBe("student@example.com");
  });

  test("rejects unsafe traversal-like usernames", () => {
    expect(() => normalizeMentorUsername("../admin")).toThrow("用户名格式不正确");
    expect(() => mentorUsernameToEmail("mentor/../../admin")).toThrow("用户名格式不正确");
  });

  test("rejects one-character and overlong usernames", () => {
    expect(() => normalizeMentorUsername("a")).toThrow("用户名格式不正确");
    expect(() => normalizeMentorUsername(`a${"b".repeat(32)}`)).toThrow("用户名格式不正确");
  });

  test("normalizes NFKC before deriving the identity", () => {
    expect(normalizeMentorUsername("ＭＲＦ")).toBe("mrf");
    expect(mentorUsernameToEmail("ＭＲＦ")).toBe(mentorUsernameToEmail("mrf"));
  });

  test("rejects direct internal authentication-domain email input", () => {
    expect(() =>
      loginIdentifierToEmail("u1_not-a-real-account@auth.copilot.sg.superbrain-ai.com"),
    ).toThrow("账号格式不正确");
  });
});
