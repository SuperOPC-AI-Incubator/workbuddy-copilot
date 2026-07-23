import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

function source(path: string): string {
  try {
    return readFileSync(resolve(process.cwd(), path), "utf8");
  } catch {
    return "";
  }
}

describe("mentor delivery UI and trust boundaries", () => {
  const desk = source("src/routes/_authenticated/index.tsx");
  const functions = source("src/lib/mentor-messages.functions.ts");
  const server = source("src/lib/mentor-messages.server.ts");
  const aiResponseServer = source("src/lib/ai-response.server.ts");
  const timelineViewFunctions = source("src/lib/timeline-view.functions.ts");
  const timelineViewServer = source("src/lib/timeline-view.server.ts");
  const aiFunctions = source("src/lib/ai.functions.ts");
  const latestMigration = source(
    "supabase/migrations/20260723090400_delivery_status_and_mentor_send.sql",
  );
  const aiServer = source("src/lib/ai.server.ts");
  const timelineDelivery = source("src/lib/timeline-delivery.ts");
  const publicDefaultSurfaces = [
    desk,
    source("src/routes/auth.tsx"),
    source("src/routes/__root.tsx"),
    source("src/lib/mcp/tools/log-prompt.ts"),
  ].join("\n");
  const intro = source("public/intro.html");

  test("removes browser mentor inserts and trusts only the server-derived bearer actor", () => {
    const sendMentor = desk.slice(
      desk.indexOf("const sendMentor"),
      desk.indexOf("const sendStudentPrompt"),
    );
    expect(sendMentor).toContain("sendMentorMessageFn");
    expect(sendMentor).not.toMatch(/from\s*\(\s*["']timeline_items["']\s*\)\.insert/);
    expect(functions).toMatch(/requireSupabaseAuth/);
    expect(functions).toMatch(/context\.userId/);
    expect(functions).not.toMatch(/studentId|authorId|authorUsername/);
    expect(server).toMatch(/_author_user_id:\s*actor\.data/);
  });

  test("keeps timeline and pending delivery creation in one service-only database transaction", () => {
    expect(latestMigration).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.create_mentor_message\s*\(\s*_author_user_id\s+uuid\s*,\s*_session_id\s+uuid/i,
    );
    expect(latestMigration).toMatch(
      /staff_accounts[\s\S]*?is_active\s*=\s*true[\s\S]*?must_change_password\s*=\s*false/i,
    );
    expect(latestMigration).toMatch(
      /INSERT\s+INTO\s+public\.timeline_items[\s\S]*?'mentor'::public\.timeline_kind/i,
    );
    expect(latestMigration).toMatch(
      /AFTER\s+INSERT[\s\S]*?create_mentor_delivery|existing AFTER INSERT trigger/i,
    );
    expect(latestMigration).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.create_mentor_message[\s\S]*?authenticated[\s\S]*?GRANT\s+EXECUTE[\s\S]*?service_role/i,
    );
  });

  test("marks only web_seen and subscribes to delivery changes with authenticated polling", () => {
    expect(desk).toMatch(/mark_mentor_messages_web_seen/);
    const webSeenEffect = desk.slice(
      desk.indexOf("mark_mentor_messages_web_seen") - 500,
      desk.indexOf("mark_mentor_messages_web_seen") + 500,
    );
    expect(webSeenEffect).not.toMatch(/acknowledged_at|ack_workbuddy/);
    expect(desk).toMatch(
      /\.on\s*\(\s*["']postgres_changes["'][\s\S]*?table:\s*["']mentor_message_deliveries["']/,
    );
    expect(desk).toMatch(/createRealtimePollingController/);
    expect(desk).toMatch(/createWebSeenVisibilityController/);
    expect(desk).toMatch(/IntersectionObserver/);
    expect(desk).toMatch(/ref=\{cardRef\}/);
    expect(timelineViewFunctions).toMatch(/requireSupabaseAuth/);
    expect(timelineViewFunctions).not.toMatch(
      /service_role|client\.server|SUPABASE_SERVICE_ROLE_KEY/,
    );
  });

  test("closes the Realtime snapshot gap and rejects stale refresh responses", () => {
    expect(desk).toMatch(
      /status\s*===\s*["']SUBSCRIBED["'][\s\S]*?invalidate\(\)[\s\S]*?refresh\(\)/,
    );
    expect(desk).toMatch(/createMonotonicRefreshController/);
  });

  test("loads timeline and delivery through one joined server snapshot", () => {
    expect(timelineViewServer).toMatch(/get_timeline_delivery_snapshot/);
    expect(timelineViewServer).not.toMatch(/Promise\.all/);
    expect(timelineViewServer).not.toMatch(
      /\.from\(["']timeline_items["']\)[\s\S]*?\.from\(["']mentor_message_deliveries["']\)/,
    );
  });

  test("renders composable badges and reloads one authoritative snapshot for each Realtime event", () => {
    expect(desk).toMatch(/describeTimelineDelivery/);
    expect(desk).toMatch(/pendingMentorDeliveryCount/);
    expect(timelineDelivery).toMatch(/历史消息（无投递记录）/);
    const selectedTimelineStart = desk.indexOf("// Timeline for current session");
    const timelineTableStart = desk.indexOf('table: "timeline_items"', selectedTimelineStart);
    const deliveryTableStart = desk.indexOf(
      'table: "mentor_message_deliveries"',
      selectedTimelineStart,
    );
    const timelineHandler = desk.slice(timelineTableStart, timelineTableStart + 800);
    const deliveryHandler = desk.slice(deliveryTableStart, deliveryTableStart + 800);
    expect(timelineHandler).toMatch(/refreshController\.refresh\(\)/);
    expect(deliveryHandler).toMatch(/refreshController\.refresh\(\)/);
    expect(timelineHandler).not.toMatch(/applyChange|setTimeline/);
    expect(deliveryHandler).not.toMatch(/applyDeliveryChange|setDeliveries/);
    expect(desk).not.toMatch(
      /\.from\("students"\)\s*\.select\("[^"]*\buser_id\b[^"]*"\)\s*\.order/,
    );
  });

  test("keeps domain selection server-only and manual delivery independent from DeepSeek", () => {
    expect(aiServer).toMatch(/resolveDomainPack\s*\(\s*process\.env\.DOMAIN_PACK/);
    expect(functions).not.toMatch(/DOMAIN_PACK|DEEPSEEK_API_KEY/);
    expect(server).not.toMatch(/DEEPSEEK|DOMAIN_PACK/);
    expect(desk).not.toMatch(/process\.env\.DOMAIN_PACK/);
    expect(publicDefaultSurfaces).not.toMatch(/PLC|工业自动化|梯形图|急停/);
  });

  test("keeps the recorded student prompt in AI context and sanitizes provider failures", () => {
    expect(aiFunctions.indexOf('kind: "prompt"')).toBeLessThan(
      aiFunctions.indexOf("const aiResult = await answerStudentPromptFromEnvironment"),
    );
    expect(aiFunctions).not.toMatch(/AI 暂时无法回答：\$\{/);
  });

  test("maps AI failures to known codes and always restores failed student input", () => {
    expect(aiServer).toMatch(/class\s+AIProviderError/);
    expect(aiServer).not.toMatch(/await\s+res\.text\(\)|text\.slice\(/);
    expect(aiFunctions).toMatch(/AI_DRAFT_FAILED/);
    expect(aiFunctions).not.toMatch(/\(err as Error\)\.message/);

    const studentSubmit = desk.slice(
      desk.indexOf("const sendStudentPrompt"),
      desk.indexOf("const draftTip"),
    );
    expect(aiFunctions).toMatch(/persistAIResponseOnServer/);
    expect(aiFunctions).not.toMatch(
      /kind:\s*["']reply["'][\s\S]*?from\(["']timeline_items["']\)\.insert/,
    );
    expect(aiResponseServer).toMatch(/create_ai_response/);
    expect(studentSubmit).not.toMatch(/setComposeText\(text\)/);
    expect(studentSubmit).not.toMatch(/alert\s*\(\s*result\.message/);
    expect(studentSubmit).not.toMatch(/\(err as Error\)\.message/);

    const mentorDraft = desk.slice(
      desk.indexOf("const draftTip"),
      desk.indexOf("const callMentor"),
    );
    expect(mentorDraft).not.toMatch(/alert\s*\(\s*result\.message/);
    expect(mentorDraft).not.toMatch(/\(err as Error\)\.message/);
  });

  test("keeps mentor and student drafts editable and version-safe while requests are pending", () => {
    const mentorSubmit = desk.slice(
      desk.indexOf("const sendMentor = async"),
      desk.indexOf("const sendStudentPrompt"),
    );
    const studentSubmit = desk.slice(
      desk.indexOf("const sendStudentPrompt"),
      desk.indexOf("const draftTip"),
    );
    expect(desk).toMatch(/createDraftSubmissionController/);
    expect(desk).toMatch(/createComposeRevisionController/);
    expect(desk).toMatch(/noteManualSendStart/);
    expect(desk).toMatch(/noteManualSendSuccess/);
    expect(mentorSubmit).not.toMatch(/setComposeText\(["']["']\)/);
    expect(studentSubmit).not.toMatch(/setComposeText\(["']["']\)/);
    expect(desk).toMatch(/mentorSendBusy/);
  });

  test("gives every AI provider request a bounded abort timeout", () => {
    expect(aiServer).toMatch(/AI_PROVIDER_TIMEOUT_MS\s*=\s*20_000/);
    expect(aiServer).toMatch(/AbortController/);
    expect(aiServer).toMatch(/signal:\s*controller\.signal/);
    expect(aiServer).toMatch(/finally[\s\S]*?clear/);
  });

  test("keeps the static public intro on the optional-AI general learning camp default", () => {
    expect(intro).toMatch(/学习营地/);
    expect(intro).toMatch(/AI\s*可选|可选的\s*AI/);
    expect(intro).not.toMatch(/PLC|工业自动化|Deepseek|必须调用/i);
  });
});
