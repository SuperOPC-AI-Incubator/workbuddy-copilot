import { describe, expect, test } from "vitest";

import {
  TRUNCATION_MARKER,
  deriveEventId,
  truncateForContract,
} from "../../connectors/workbuddy-event-id.mjs";

/** Copied verbatim from the connector's own validator. Do not relax. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SESSION = "c60cf1ae-1385-4b4b-9eb3-8edca841b114";
const MESSAGE = "bb40cd6f-04c9-4a7c-abb6-2431159c8975";

describe("deriveEventId", () => {
  test("always produces an id the connector accepts", () => {
    const inputs: Array<[string, string]> = [
      [SESSION, MESSAGE],
      ["33d41449a65f42d283820f0c9d3a8c8c", "1227434f9eff48c49a34662711fca7c7"],
      ["会话/α", "消息-β"],
      ["s", "m"],
      ["x".repeat(300), "y".repeat(300)],
    ];
    for (const [session, message] of inputs) {
      const id = deriveEventId(session, message);
      expect(id, `${session}/${message}`).toMatch(UUID_PATTERN);
      expect(id).toBe(id.toLowerCase());
      // Version 4 nibble and RFC-4122 variant bits.
      expect(id[14]).toBe("4");
      expect("89ab").toContain(id[19]);
    }
  });

  test("is stable across calls and matches a pinned golden value", () => {
    const first = deriveEventId(SESSION, MESSAGE);
    const second = deriveEventId(SESSION, MESSAGE);

    expect(first).toBe(second);
    // Pinned so a change in the derivation rule (which would break idempotency
    // against events already stored on the server) fails loudly.
    expect(first).toBe("dca4071b-34ee-4732-9ab2-90b32ca3c9a9");
  });

  test("separates the two inputs so they cannot be confused", () => {
    expect(deriveEventId("ab", "c")).not.toBe(deriveEventId("a", "bc"));
    expect(deriveEventId(SESSION, MESSAGE)).not.toBe(deriveEventId(MESSAGE, SESSION));
    expect(deriveEventId(SESSION, "u1")).not.toBe(deriveEventId(SESSION, "u2"));
    expect(deriveEventId("session-a", "u1")).not.toBe(deriveEventId("session-b", "u1"));
  });

  test("refuses to invent an id from missing inputs", () => {
    expect(() => deriveEventId("", MESSAGE)).toThrow();
    expect(() => deriveEventId(SESSION, "")).toThrow();
  });
});

describe("truncateForContract", () => {
  test("leaves text at or under the limit untouched", () => {
    expect(truncateForContract("短文本", 4_000)).toEqual({ text: "短文本", truncated: false });
    const exact = "a".repeat(120);
    expect(truncateForContract(exact, 120)).toEqual({ text: exact, truncated: false });
  });

  test("never exceeds the limit, counting the marker itself", () => {
    for (const max of [
      1,
      2,
      5,
      10,
      TRUNCATION_MARKER.length - 1,
      TRUNCATION_MARKER.length,
      TRUNCATION_MARKER.length + 1,
      120,
      255,
      4_000,
      8_000,
    ]) {
      const result = truncateForContract("字".repeat(20_000), max);
      expect(result.truncated).toBe(true);
      expect(result.text.length, `max=${max}`).toBeLessThanOrEqual(max);
      expect(result.text.trim().length).toBeGreaterThan(0);
    }
  });

  test("leaves a visible marker when it cut something", () => {
    const result = truncateForContract("答".repeat(9_000), 8_000);

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(8_000);
    expect(result.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.text.startsWith("答答答")).toBe(true);
  });

  test("keeps the head intact up to the marker budget", () => {
    const source = `${"头".repeat(50)}${"尾".repeat(500)}`;
    const result = truncateForContract(source, 60);

    expect(result.text.length).toBeLessThanOrEqual(60);
    expect(result.text.startsWith("头".repeat(50 - TRUNCATION_MARKER.length))).toBe(true);
  });

  test("does not leave a dangling surrogate half behind", () => {
    // Each emoji is two UTF-16 code units, so an odd budget lands mid-pair.
    const source = "🐛".repeat(100);
    const result = truncateForContract(source, TRUNCATION_MARKER.length + 5);

    expect(result.text.length).toBeLessThanOrEqual(TRUNCATION_MARKER.length + 5);
    for (let index = 0; index < result.text.length; index += 1) {
      const code = result.text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.text.charCodeAt(index + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
    expect(JSON.parse(JSON.stringify(result.text))).toBe(result.text);
    expect(Buffer.from(result.text, "utf8").toString("utf8")).toBe(result.text);
  });

  test("handles non-string and empty inputs without throwing", () => {
    expect(truncateForContract("", 100)).toEqual({ text: "", truncated: false });
    expect(truncateForContract(undefined as unknown as string, 100).text).toBe("");
    expect(truncateForContract("abc", 0)).toEqual({ text: "", truncated: true });
  });
});
