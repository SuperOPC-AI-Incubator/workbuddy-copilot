import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { ReliableWorkbuddyTurnSchema } from "@/lib/workbuddy/contracts";
import { buildWorkbuddySkill } from "@/lib/workbuddy/skill-template";

const setupRoute = readFileSync(
  resolve(process.cwd(), "src/routes/_authenticated/workbuddy.tsx"),
  "utf8",
);
const mcpIndex = readFileSync(resolve(process.cwd(), "src/lib/mcp/index.ts"), "utf8");
const ensureActiveSession = readFileSync(
  resolve(process.cwd(), "src/lib/mcp/tools/ensure-active-session.ts"),
  "utf8",
);
const invokeToolRoute = readFileSync(
  resolve(process.cwd(), "src/routes/[.mcp]/invoke-tool/$tool.ts"),
  "utf8",
);
const ingestDocs = readFileSync(resolve(process.cwd(), "docs/workbuddy-ingest.md"), "utf8");

describe("WorkBuddy SKILL generator", () => {
  test("emits a reliable-turn JSON example accepted by the production schema", () => {
    const skill = buildWorkbuddySkill({
      ingestUrl: "https://copilot.example.test/api/public/workbuddy/ingest",
      credentialPlaceholder: "<WORKBUDDY_CREDENTIAL>",
    });
    const jsonBlock = skill.match(/```json\n([\s\S]*?)\n```/)?.[1];

    expect(jsonBlock).toBeDefined();
    const parsed = ReliableWorkbuddyTurnSchema.parse(JSON.parse(jsonBlock!));
    expect(parsed.source).toBe("connector");
    expect(parsed.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(parsed.source_session_key).toBe("workbuddy-conversation-stable-key");
    expect(skill).toContain("workbuddy-sync.mjs");
    expect(skill).not.toMatch(/Authorization|Bearer|WORKBUDDY_CREDENTIAL/);
    expect(skill).toMatch(/每一轮.*新的 event_id/);
    expect(skill).toMatch(/重试.*同一个 event_id/);
    expect(skill).toMatch(/source_session_key.*同一段.*复用/);
    expect(skill).not.toMatch(/"session"\s*:/);
    expect(skill).not.toMatch(/"items"\s*:/);
    expect(skill).not.toMatch(/"kind"\s*:/);
    expect(skill).not.toMatch(/"session_id"\s*:/);
  });

  test("setup page no longer reads or renders the legacy plaintext token", () => {
    expect(setupRoute).not.toMatch(/buildWorkbuddySkill/);
    expect(setupRoute).toMatch(/\/downloads\/SKILL\.md/);
    expect(setupRoute).toMatch(/重新安装|更新旧版|旧版[\s\S]*更新|重新接入/);
    expect(setupRoute).toMatch(/接入凭证[\s\S]*?仅显示这一次/);
    expect(setupRoute).toMatch(/createWorkbuddyCredential/);
    expect(setupRoute).toMatch(/rotateWorkbuddyCredential/);
    expect(setupRoute).not.toMatch(/get_my_legacy_workbuddy_setup/);
    expect(setupRoute).not.toMatch(/workbuddy_token/);
    expect(setupRoute).not.toMatch(/superbrain-copilot\.lovable\.app/);
  });

  test("documentation explicitly retires the old session/items SKILL shape", () => {
    expect(ingestDocs).toMatch(/update the old SKILL|reinstall/i);
    expect(ingestDocs).toMatch(/old SKILL[\s\S]*?session[\s\S]*?items/i);
  });
});

describe("MCP reliable write surface", () => {
  test("registers log_turn as the only conversation logging entry", () => {
    expect(mcpIndex).toMatch(/tools:\s*\[\s*logTurnTool\s*,/);
    for (const removedTool of [
      "logPromptTool",
      "logReplyTool",
      "logDiagnosisTool",
      "ensureActiveSessionTool",
      "createSessionTool",
    ]) {
      expect(mcpIndex).not.toContain(removedTool);
    }
    for (const removedName of [
      "log_prompt",
      "log_reply",
      "log_diagnosis",
      "ensure_active_session",
      "create_session",
    ]) {
      expect(mcpIndex).not.toContain(removedName);
    }

    expect(invokeToolRoute).toMatch(/import mcp from .*lib\/mcp\/index/);
    expect(invokeToolRoute).not.toMatch(/import\s*\(\s*.*\$tool/);
  });

  test("deprecated ensure_active_session cannot write or return a cloud session id", () => {
    expect(ensureActiveSession).toMatch(/source_session_key/);
    expect(ensureActiveSession).toMatch(/已停用|deprecated/i);
    expect(ensureActiveSession).not.toMatch(/session_id/);
    expect(ensureActiveSession).not.toMatch(/\.from\s*\(/);
    expect(ensureActiveSession).not.toMatch(/\.insert\s*\(/);
  });
});
