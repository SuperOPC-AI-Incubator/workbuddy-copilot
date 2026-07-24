import { expect, test } from "@playwright/test";

import {
  E2E_ENVIRONMENT,
  createE2EHarness,
  loginWithPassword,
  type E2EHarness,
} from "./support/e2e-fixture";

const MISSING_MESSAGE_ID = "00000000-0000-4000-8000-000000000404";

type DeliveredMentorMessage = {
  id: string;
  session_id: string;
  text: string;
  author_username: string;
  created_at: string;
  fetch_count: number;
  first_fetched_at: string;
  last_fetched_at: string;
};

test.describe("WorkBuddy cloud delivery loop", () => {
  test.skip(!E2E_ENVIRONMENT.available, E2E_ENVIRONMENT.skipReason);
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  let harness: E2EHarness;

  test.beforeEach(async () => {
    harness = await createE2EHarness();
  });

  test.afterEach(async () => {
    await harness?.cleanup();
  });

  test("ingest reaches the mentor, reply reaches web and WorkBuddy until acknowledged", async ({
    browser,
    page,
  }) => {
    const negativeControl = process.env.E2E_NEGATIVE_CONTROL === "workbuddy-delivery";
    const negativeMarker = negativeControl ? process.env.E2E_NEGATIVE_CONTROL_MARKER : undefined;
    const mentor = await harness.createStaff({
      prefix: "loopmentor",
      mustChangePassword: false,
      teamAdmin: false,
    });
    const student = await harness.createStudent("闭环学员");
    const otherStudent = await harness.createStudent("隔离学员");
    const eventId = crypto.randomUUID();
    const sourceSessionKey = harness.uniqueLabel("workbuddy-session");
    const title = harness.uniqueLabel("闭环会话");
    const prompt = harness.uniqueLabel("精确学员问题");
    const reply = harness.uniqueLabel("精确 WorkBuddy 回答");
    const diagnosis = harness.uniqueLabel("精确诊断");
    const turn = {
      event_id: eventId,
      source: "connector",
      source_session_key: sourceSessionKey,
      session_title: title,
      prompt,
      reply,
      diagnosis: { text: diagnosis, severity: "warn" },
      client_created_at: new Date().toISOString(),
    } as const;

    const firstIngest = await harness.publicJson("/api/public/workbuddy/ingest", {
      method: "POST",
      token: student.token,
      body: turn,
    });
    expect(firstIngest.status).toBe(200);
    expect(firstIngest.body).toMatchObject({
      ok: true,
      event_id: eventId,
      duplicate: false,
      item_ids: {
        prompt: expect.any(String),
        reply: expect.any(String),
        diagnosis: expect.any(String),
      },
    });
    const sessionId = String(firstIngest.body.session_id);

    const duplicate = await harness.publicJson("/api/public/workbuddy/ingest", {
      method: "POST",
      token: student.token,
      body: turn,
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({
      event_id: eventId,
      session_id: sessionId,
      item_ids: firstIngest.body.item_ids,
      duplicate: true,
    });

    const conflict = await harness.publicJson("/api/public/workbuddy/ingest", {
      method: "POST",
      token: student.token,
      body: { ...turn, prompt: `${prompt} changed` },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      error: {
        code: "EVENT_ID_CONFLICT",
        message: "Event ID conflicts with stored payload",
      },
    });

    await loginWithPassword(page, mentor.username, harness.initialPassword);
    await page.getByRole("button", { name: student.displayName }).click();
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await expect(page.getByText(prompt, { exact: true })).toBeVisible();
    await expect(page.getByText(reply, { exact: true })).toBeVisible();
    await expect(page.getByText(diagnosis, { exact: true })).toBeVisible();

    const mentorReply = harness.uniqueLabel("导师精确回复");
    await page.getByPlaceholder(/发送导师提示/).fill(mentorReply);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText(mentorReply, { exact: true })).toBeVisible();

    const studentContext = await browser.newContext();
    try {
      const studentPage = await studentContext.newPage();
      await loginWithPassword(studentPage, student.email, harness.initialPassword);
      await studentPage.getByRole("button", { name: new RegExp(title) }).click();
      await expect(studentPage.getByText(mentorReply, { exact: true })).toBeVisible();
    } finally {
      await studentContext.close();
    }

    const messageId = await harness.readTimelineItemId(sessionId, mentorReply);
    await expect(harness.readDelivery(messageId)).resolves.toMatchObject({
      fetchCount: 0,
      acknowledged: false,
      studentId: student.studentId,
      sessionId,
    });

    const beforeFetchAck = await harness.publicJson("/api/public/workbuddy/mentor-messages/ack", {
      method: "POST",
      token: student.token,
      body: { message_ids: [messageId] },
    });
    expect(beforeFetchAck.status).toBe(400);
    expect(beforeFetchAck.body).toMatchObject({
      error: { code: "INVALID_MESSAGE_IDS" },
    });
    await expect(harness.readDelivery(messageId)).resolves.toMatchObject({
      fetchCount: 0,
      acknowledged: false,
    });

    const firstFetch = await harness.publicJson(
      `/api/public/workbuddy/mentor-messages?session_id=${sessionId}`,
      { method: "GET", token: student.token },
    );
    expect(firstFetch.status).toBe(200);
    expect(firstFetch.body).toMatchObject({
      ok: true,
      messages: [
        {
          id: expect.any(String),
          session_id: sessionId,
          text: mentorReply,
          author_username: mentor.username,
          created_at: expect.any(String),
        },
      ],
      next_cursor: null,
    });
    const firstMessages = firstFetch.body.messages as DeliveredMentorMessage[];
    expect(firstMessages).toHaveLength(1);
    expect(firstMessages[0]?.fetch_count).toBe(1);
    expect(String(firstMessages[0]?.id)).toBe(messageId);
    expect(
      firstMessages.map(({ id }) => id),
      negativeMarker,
    ).toContain(negativeControl ? MISSING_MESSAGE_ID : messageId);

    const repeatedFetch = await harness.publicJson(
      `/api/public/workbuddy/mentor-messages?session_id=${sessionId}`,
      { method: "GET", token: student.token },
    );
    expect(repeatedFetch.status).toBe(200);
    const repeatedMessages = repeatedFetch.body.messages as DeliveredMentorMessage[];
    expect(repeatedMessages).toHaveLength(1);
    expect(repeatedMessages[0]).toMatchObject({
      id: firstMessages[0]?.id,
      session_id: firstMessages[0]?.session_id,
      text: firstMessages[0]?.text,
      author_username: firstMessages[0]?.author_username,
      created_at: firstMessages[0]?.created_at,
      fetch_count: 2,
      first_fetched_at: firstMessages[0]?.first_fetched_at,
      last_fetched_at: expect.any(String),
    });
    expect(Date.parse(repeatedMessages[0]!.last_fetched_at)).toBeGreaterThanOrEqual(
      Date.parse(firstMessages[0]!.last_fetched_at),
    );

    const wrongStudentFetch = await harness.publicJson(
      `/api/public/workbuddy/mentor-messages?session_id=${sessionId}`,
      { method: "GET", token: otherStudent.token },
    );
    expect(wrongStudentFetch.status).toBe(400);
    expect(wrongStudentFetch.body).toMatchObject({
      error: { code: "INVALID_SESSION" },
    });

    const wrongStudentAck = await harness.publicJson("/api/public/workbuddy/mentor-messages/ack", {
      method: "POST",
      token: otherStudent.token,
      body: { message_ids: [messageId] },
    });
    expect(wrongStudentAck.status).toBe(400);
    expect(wrongStudentAck.body).toMatchObject({
      error: { code: "INVALID_MESSAGE_IDS" },
    });

    const acknowledged = await harness.publicJson("/api/public/workbuddy/mentor-messages/ack", {
      method: "POST",
      token: student.token,
      body: { message_ids: [messageId] },
    });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body).toMatchObject({
      ok: true,
      acknowledged: [{ id: messageId, acknowledged_at: expect.any(String) }],
    });

    const afterAck = await harness.publicJson(
      `/api/public/workbuddy/mentor-messages?session_id=${sessionId}`,
      { method: "GET", token: student.token },
    );
    expect(afterAck.status).toBe(200);
    expect(afterAck.body).toMatchObject({ messages: [], next_cursor: null });
    await expect(harness.readDelivery(messageId)).resolves.toMatchObject({
      fetchCount: 2,
      acknowledged: true,
      studentId: student.studentId,
      sessionId,
    });
  });
});
