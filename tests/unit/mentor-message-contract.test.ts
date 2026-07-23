import { describe, expect, test } from "vitest";

import {
  MENTOR_MESSAGE_INPUT_MAX_CODE_UNITS,
  MENTOR_MESSAGE_MAX_CHARACTERS,
  countUnicodeCharacters,
  isMentorMessageWithinLimit,
} from "@/lib/workbuddy/mentor-message-contract";

describe("mentor message content contract", () => {
  test("shares the database boundary of 8000 Unicode characters", () => {
    expect(MENTOR_MESSAGE_MAX_CHARACTERS).toBe(8_000);
    expect(countUnicodeCharacters("A😀学")).toBe(3);
    expect(countUnicodeCharacters("学".repeat(8_000))).toBe(8_000);
    expect(countUnicodeCharacters("学".repeat(8_001))).toBe(8_001);
    expect(isMentorMessageWithinLimit("😀".repeat(8_000))).toBe(true);
    expect(isMentorMessageWithinLimit("😀".repeat(8_001))).toBe(false);
  });

  test("lets 8001 surrogate-pair characters reach JS so it can reject them", () => {
    const accepted = "😀".repeat(8_000);
    const rejected = "😀".repeat(8_001);
    const browserValue = rejected.slice(0, MENTOR_MESSAGE_INPUT_MAX_CODE_UNITS);

    expect(MENTOR_MESSAGE_INPUT_MAX_CODE_UNITS).toBe(16_002);
    expect(accepted.length).toBeLessThan(MENTOR_MESSAGE_INPUT_MAX_CODE_UNITS);
    expect(isMentorMessageWithinLimit(accepted)).toBe(true);
    expect(rejected.length).toBe(MENTOR_MESSAGE_INPUT_MAX_CODE_UNITS);
    expect(browserValue).toBe(rejected);
    expect(countUnicodeCharacters(browserValue)).toBe(8_001);
    expect(isMentorMessageWithinLimit(browserValue)).toBe(false);
  });

  test("validates the trimmed text that is actually submitted", () => {
    const acceptedWithTrailingWhitespace = `${"😀".repeat(8_000)}   \n`;
    const rejectedWithTrailingWhitespace = `${"😀".repeat(8_001)}   \n`;

    expect(isMentorMessageWithinLimit(acceptedWithTrailingWhitespace.trim())).toBe(true);
    expect(isMentorMessageWithinLimit(rejectedWithTrailingWhitespace.trim())).toBe(false);
  });
});
