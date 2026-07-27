import { describe, expect, test, vi } from "vitest";

import { diagnoseWorkbuddyTurn } from "@/lib/ai.server";

test("redacts learner content before sending a WorkBuddy diagnosis to the provider", async () => {
  const providerKey = "provider-key-must-never-appear-in-content";
  const privateApiKey = "sk-LEAKED-CREDENTIAL-abcdef0123456789";
  const privateEmail = "learner.private@example.com";
  const privatePhone = "13800138000";
  const privateDatabaseUrl = "postgres://learner:password@private-db.example.test/app";
  let outboundBody = "";
  const fetchProvider = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    outboundBody = String(init?.body);
    return Response.json({
      choices: [{ message: { content: '{"diagnosis":"可验证","severity":"ok","tag":"验证"}' } }],
    });
  });

  await diagnoseWorkbuddyTurn(
    {
      prompt: `请检查 ${privateApiKey}，联系我 ${privateEmail} 或 ${privatePhone}`,
      reply: `数据库配置是 ${privateDatabaseUrl}`,
      context: [{ kind: "mentor", text: `不要暴露 ${privateApiKey}` }],
    },
    providerKey,
    { fetch: fetchProvider },
    { url: "https://provider.example.test/v1/chat/completions", model: "test-model" },
  );

  expect(outboundBody).not.toContain(privateApiKey);
  expect(outboundBody).not.toContain(privateEmail);
  expect(outboundBody).not.toContain(privatePhone);
  expect(outboundBody).not.toContain(privateDatabaseUrl);
  expect(outboundBody).toContain("[REDACTED]");
});
