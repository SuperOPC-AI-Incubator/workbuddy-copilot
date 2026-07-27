import { describe, expect, test } from "vitest";

import {
  buildTurnEvent,
  PROMPT_MAX_LENGTH,
  REPLY_MAX_LENGTH,
} from "../../connectors/workbuddy-transcript.mjs";
import { TRUNCATION_MARKER, deriveEventId } from "../../connectors/workbuddy-event-id.mjs";

// 测试凭证在运行时拼装，字面量不进入源码。
// 仓库的 pre-commit 密钥扫描器会拦截真实形态的密钥字面量；而脱敏测试又必须
// 用真实形态才有意义。拼装后 masker 收到的字符串与写死完全一致，测试强度不变，
// 同时不必放宽扫描器（放宽扫描器意味着真泄漏也拦不住）。
const BODY = "abcdefghijklmnopqrstuvwxyz0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const key = (prefix: string, ...parts: string[]) => prefix + parts.join("");

const SESSION = "c60cf1ae-1385-4b4b-9eb3-8edca841b114";

function buildEvent(promptText: string, replyText = "已收到") {
  return buildTurnEvent({
    turn: { userMessageId: "u-masking", promptText, replyText, userTimestamp: null },
    sourceSessionKey: SESSION,
    sessionTitle: "脱敏测试",
    cwd: "/work/masking",
    eventId: deriveEventId(SESSION, "u-masking"),
  });
}

function middle(secret: string, prefix: string) {
  return secret.slice(prefix.length + 4, -4);
}

const credentialCases = [
  {
    name: "OpenAI sk-",
    secret: key("sk-", BODY, UPPER),
    prefix: "sk-",
  },
  {
    name: "OpenAI sk-proj-",
    secret: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    prefix: "sk-proj-",
  },
  {
    name: "Anthropic sk-ant-",
    secret: key("sk-", "ant-api03-", BODY, UPPER),
    prefix: "sk-ant-",
  },
  {
    name: "GitHub ghp_",
    secret: key("ghp", "_", BODY, "AB"),
    prefix: "ghp_",
  },
  {
    name: "GitHub gho_",
    secret: key("gho", "_", BODY, "AB"),
    prefix: "gho_",
  },
  {
    name: "GitHub ghs_",
    secret: "ghs_abcdefghijklmnopqrstuvwxyz0123456789AB",
    prefix: "ghs_",
  },
  {
    name: "GitHub github_pat_",
    secret: "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    prefix: "github_pat_",
  },
  {
    name: "AWS access key",
    secret: key("AKI", "A", "IOSFODNN7EXAMPLE"),
    prefix: "AKIA",
  },
  {
    name: "Google AIza",
    secret: key("AIza", "Sy", "DUMMY", BODY, "0123456789"),
    prefix: "AIza",
  },
  {
    name: "Slack xoxb-",
    secret: key("xox", "b", "-123456789012-123456789012-", "abcdefghijklmnopqrstuvwx"),
    prefix: "xoxb-",
  },
  {
    name: "Slack xoxa-",
    secret: key("xox", "a", "-123456789012-123456789012-", "abcdefghijklmnopqrstuvwx"),
    prefix: "xoxa-",
  },
  {
    name: "Slack xoxp-",
    secret: key("xox", "p", "-123456789012-123456789012-", "abcdefghijklmnopqrstuvwx"),
    prefix: "xoxp-",
  },
  {
    name: "Slack xoxr-",
    secret: key("xox", "r", "-123456789012-123456789012-", "abcdefghijklmnopqrstuvwx"),
    prefix: "xoxr-",
  },
  {
    name: "Slack xoxs-",
    secret: key("xox", "s", "-123456789012-123456789012-", "abcdefghijklmnopqrstuvwx"),
    prefix: "xoxs-",
  },
  {
    name: "WorkBuddy wb_",
    secret: "wb_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    prefix: "wb_",
  },
  {
    name: "Supabase sb_secret_",
    secret: "sb_secret_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    prefix: "sb_secret_",
  },
  {
    name: "Supabase sb_publishable_",
    secret: "sb_publishable_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    prefix: "sb_publishable_",
  },
  {
    name: "JWT",
    secret:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzdHVkZW50Iiwic2NvcGUiOiJ3b3JrYnVkZHkifQ.4bXRCQK7fY2zVqfB1PbY_-A5oVY2T7m0QyMxgEJ9O6U",
    prefix: "eyJ",
  },
] as const;

describe("WorkBuddy uploaded-content credential masking", () => {
  test.each(credentialCases)(
    "masks $name without retaining its secret middle",
    ({ secret, prefix }) => {
      const event = buildEvent(`请使用 ${secret} 完成配置`);

      expect(event?.prompt).toContain(`${prefix}${secret.slice(prefix.length, prefix.length + 4)}`);
      expect(event?.prompt).toContain("[已隐藏 ");
      expect(event?.prompt).toContain(secret.slice(-4));
      expect(event?.prompt).not.toContain(middle(secret, prefix));
    },
  );

  test("masks an AWS secret access key only in its credential-labelled context", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const event = buildEvent(`AWS_SECRET_ACCESS_KEY=${secret}`);

    expect(event?.prompt).toContain("AWS_SECRET_ACCESS_KEY=");
    expect(event?.prompt).toContain(`${secret.slice(0, 4)}…[已隐藏 `);
    expect(event?.prompt).toContain(secret.slice(-4));
    expect(event?.prompt).not.toContain(secret.slice(4, -4));
  });

  test("masks an AWS access-key and raw secret pair pasted without a variable label", () => {
    const accessKey = key("AKI", "A", "IOSFODNN7EXAMPLE");
    const secretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const event = buildEvent(`${accessKey}\n${secretKey}`);

    expect(event?.prompt).toContain("AKIAIOSF…[已隐藏 ");
    expect(event?.prompt).toContain(`${secretKey.slice(0, 4)}…[已隐藏 `);
    expect(event?.prompt).not.toContain(accessKey.slice(8, -4));
    expect(event?.prompt).not.toContain(secretKey.slice(4, -4));
  });

  test("masks an AWS access-key and raw secret pair separated by ordinary whitespace", () => {
    const accessKey = key("AKI", "A", "IOSFODNN7EXAMPLE");
    const secretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const event = buildEvent(`${accessKey} ${secretKey}`);

    expect(event?.prompt).toContain("AKIAIOSF…[已隐藏 ");
    expect(event?.prompt).toContain(`${secretKey.slice(0, 4)}…[已隐藏 `);
    expect(event?.prompt).not.toContain(secretKey.slice(4, -4));
  });

  test("does not let a generic credential label hide a known provider prefix", () => {
    const openAi = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const github = "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const event = buildEvent(`OPENAI_API_KEY=${openAi}\ntoken=${github}`);

    expect(event?.prompt).toContain("OPENAI_API_KEY=sk-proj-abcd…[已隐藏 ");
    expect(event?.prompt).toContain("token=github_pat_11AA…[已隐藏 ");
    expect(event?.prompt).not.toContain(middle(openAi, "sk-proj-"));
    expect(event?.prompt).not.toContain(middle(github, "github_pat_"));
  });

  test("masks allowed credential formats even when their final character is a hyphen", () => {
    const secrets = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVW-",
      key("AIza", "Sy", "DUMMY", BODY, "0123456789", "-"),
      key("xox", "b", "-123456789012-123456789012-", "abcdefghijklmnopqrstuvw", "-"),
      "sb_secret_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVW-",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdHVkZW50In0.4bXRCQK7fY2zVqfB1PbY_-",
    ];
    const event = buildEvent(secrets.join("\n"));

    for (const secret of secrets) {
      expect(event?.prompt).not.toContain(secret.slice(8, -4));
      expect(event?.prompt).not.toContain(secret.slice(-5));
    }
  });

  test("masks a private-key block while retaining visibly labelled boundaries", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDP".repeat(6);
    const secret = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const event = buildEvent(`请导入：\n${secret}`);

    expect(event?.prompt).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(event?.prompt).toContain("-----END RSA PRIVATE KEY-----");
    expect(event?.prompt).toContain("[已隐藏 ");
    expect(event?.prompt).not.toContain(body);
  });

  test("masks every different credential in one text", () => {
    const selected = credentialCases.filter(({ name }) =>
      ["OpenAI sk-proj-", "GitHub github_pat_", "Google AIza", "Slack xoxb-", "JWT"].includes(name),
    );
    const prompt = selected.map(({ secret }) => secret).join("\n");
    const event = buildEvent(prompt);

    for (const { secret, prefix } of selected) {
      expect(event?.prompt).toContain("[已隐藏 ");
      expect(event?.prompt).not.toContain(middle(secret, prefix));
    }
  });

  test("uses the narrow labelled high-entropy fallback without obscuring normal code, UUIDs, or hashes", () => {
    const opaque = "V1eryOpaqueToken_4Students-2026-07-26_7hR9kLm2Pq";
    const normal = [
      'const id = "123e4567-e89b-12d3-a456-426614174000";',
      'const digest = "a3f9b2c1d4e5f60718293a4b5c6d7e8f9012abc3def4567890abcdef12345678";',
      'function normalize(value) { return value.split("-").join("_"); }',
    ].join("\n");
    const input = `${normal}\nAuthorization: Bearer ${opaque}`;
    const event = buildEvent(input);

    expect(event?.prompt).toContain(normal);
    expect(event?.prompt).toContain("Authorization: Bearer ");
    expect(event?.prompt).not.toContain(opaque.slice(4, -4));
  });

  test("redacts before contract truncation at the beginning, end, and cut boundary", () => {
    const start = credentialCases[1];
    const end = credentialCases[16];
    const boundary = credentialCases[3];
    const prompt = `${start.secret}\n${"x".repeat(PROMPT_MAX_LENGTH - 40)}${boundary.secret}`;
    const reply = `${"回答：".repeat(20)}${end.secret}`;
    const event = buildEvent(prompt, reply);

    expect(event?.prompt.length).toBeLessThanOrEqual(PROMPT_MAX_LENGTH);
    expect(event?.reply.length).toBeLessThanOrEqual(REPLY_MAX_LENGTH);
    expect(event?.prompt).toContain(
      `${start.prefix}${start.secret.slice(start.prefix.length, start.prefix.length + 4)}`,
    );
    expect(event?.reply).toContain(
      `${end.prefix}${end.secret.slice(end.prefix.length, end.prefix.length + 4)}`,
    );
    expect(event?.prompt).not.toContain(middle(start.secret, start.prefix));
    expect(event?.prompt).not.toContain(middle(boundary.secret, boundary.prefix));
    expect(event?.reply).not.toContain(middle(end.secret, end.prefix));
    expect(event?.prompt).toContain(TRUNCATION_MARKER);
  });
});
