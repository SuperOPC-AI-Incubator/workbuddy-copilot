import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  TITLE_HEAD_BYTES,
  TITLE_TAIL_BYTES,
  buildTurnEvent,
  extractUserQuery,
  findSessionTitle,
  parseTranscriptTail,
  readSessionTitle,
  resolveSessionTitle,
} from "../../connectors/workbuddy-transcript.mjs";
import { deriveEventId } from "../../connectors/workbuddy-event-id.mjs";

const SESSION = "c60cf1ae-1385-4b4b-9eb3-8edca841b114";
const CWD = "/Users/michael/WorkBuddy/2026-07-25-17-46-47";

/** A user row exactly as WorkBuddy writes it: real prompt buried in reminders. */
function userRow(id: string, query: string, timestamp = 1_784_972_810_066): string {
  const wrapped =
    `<system-reminder data-role="user-context">\n<user_info>\nOS Version: darwin\n` +
    `Workspace Folder: ${CWD}\n</user_info>\n</system-reminder>\n<user_query>${query}</user_query>`;
  return JSON.stringify({
    id,
    timestamp,
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: wrapped }],
    providerData: { agent: "cli" },
    sessionId: SESSION,
    cwd: CWD,
  });
}

function assistantRow(id: string, text: string, timestamp = 1_784_972_835_055): string {
  return JSON.stringify({
    id,
    parentId: "parent",
    timestamp,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ providerData: { annotations: [] }, type: "output_text", text }],
    providerData: { model: "hy3", agent: "cli" },
    sessionId: SESSION,
    cwd: CWD,
  });
}

function lines(...rows: string[]): string {
  return `${rows.join("\n")}\n`;
}

describe("parseTranscriptTail turn extraction", () => {
  test("pairs each user message with the assistant text that follows it", () => {
    const body = lines(
      userRow("u1", "第一个问题"),
      assistantRow("a1", "第一个回答"),
      userRow("u2", "第二个问题"),
      assistantRow("a2", "第二个回答"),
    );

    const parsed = parseTranscriptTail(body);

    expect(parsed.droppedLeadingPartial).toBe(false);
    expect(parsed.droppedTrailingPartial).toBe(false);
    expect(parsed.turns).toEqual([
      {
        userMessageId: "u1",
        promptText: "第一个问题",
        replyText: "第一个回答",
        userTimestamp: 1_784_972_810_066,
      },
      {
        userMessageId: "u2",
        promptText: "第二个问题",
        replyText: "第二个回答",
        userTimestamp: 1_784_972_810_066,
      },
    ]);
  });

  test("merges every assistant message of a round into one reply, in order", () => {
    const body = lines(
      userRow("u1", "帮我做三步"),
      assistantRow("a1", "第一步：读文件"),
      assistantRow("a2", "第二步：改代码"),
      assistantRow("a3", "第三步：跑测试"),
      userRow("u2", "下一个问题"),
      assistantRow("a4", "另一个回答"),
    );

    const parsed = parseTranscriptTail(body);

    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].replyText).toBe("第一步：读文件\n\n第二步：改代码\n\n第三步：跑测试");
    expect(parsed.turns[1].replyText).toBe("另一个回答");
  });

  test("drops a byte-truncated leading line instead of treating it as a message", () => {
    const body = lines(
      userRow("u1", "被截断的问题"),
      assistantRow("a1", "被截断轮的回答"),
      userRow("u2", "完整的问题"),
      assistantRow("a2", "完整的回答"),
    );
    // Cut in the middle of the first line, the way a 256 KiB tail read does.
    const tail = body.slice(120);
    expect(tail.startsWith("{")).toBe(false);

    const parsed = parseTranscriptTail(Buffer.from(tail, "utf8"));

    expect(parsed.droppedLeadingPartial).toBe(true);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]).toMatchObject({
      userMessageId: "u2",
      promptText: "完整的问题",
      replyText: "完整的回答",
    });
    // The half message must not leak in through any field.
    expect(JSON.stringify(parsed.turns)).not.toContain("被截断");
  });

  test("drops an unterminated final line and flags it", () => {
    const body =
      lines(userRow("u1", "第一个问题"), assistantRow("a1", "第一个回答")) +
      `${userRow("u2", "第二个问题")}\n${assistantRow("a2", "只写了一半的回答")}`.slice(0, -40);

    const parsed = parseTranscriptTail(body);

    expect(parsed.droppedTrailingPartial).toBe(true);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].userMessageId).toBe("u1");
    expect(JSON.stringify(parsed.turns)).not.toContain("只写了一半");
  });

  test("flushes the preceding round before an image-only user message", () => {
    const body = lines(
      userRow("u1", "文字问题"),
      assistantRow("a1", "文字回答"),
      JSON.stringify({
        id: "image-only",
        timestamp: 3,
        type: "message",
        role: "user",
        content: [{ type: "image_blob_ref", blob_id: "private-image" }],
        sessionId: SESSION,
        cwd: CWD,
      }),
      assistantRow("a2", "图片的回答"),
    );

    const parsed = parseTranscriptTail(body);

    // An image-only prompt deliberately has no uploadable text. Its reply must
    // therefore not be attributed to the preceding text prompt.
    expect(parsed.turns).toEqual([
      {
        userMessageId: "u1",
        promptText: "文字问题",
        replyText: "文字回答",
        userTimestamp: 1_784_972_810_066,
      },
    ]);
  });

  test("treats a body with no newline at all as one unterminated line", () => {
    const parsed = parseTranscriptTail(userRow("u1", "没有换行"));

    expect(parsed.droppedTrailingPartial).toBe(true);
    expect(parsed.turns).toEqual([]);
  });

  test("never surfaces tool call arguments, tool results or blob references", () => {
    const secret = "sk-LEAKED-CREDENTIAL-abcdef0123456789";
    const body = lines(
      userRow("u1", "读一下 .env 然后总结"),
      JSON.stringify({
        id: "fc1",
        timestamp: 1,
        type: "function_call",
        name: "read_file",
        callId: "call-1",
        arguments: JSON.stringify({ path: "/Users/michael/secret/.env" }),
        sessionId: SESSION,
        cwd: CWD,
      }),
      JSON.stringify({
        id: "fr1",
        timestamp: 2,
        type: "function_call_result",
        name: "read_file",
        callId: "call-1",
        status: "completed",
        output: `OPENAI_API_KEY=${secret}\nDATABASE_URL=postgres://user:pw@host/db`,
        sessionId: SESSION,
        cwd: CWD,
      }),
      JSON.stringify({
        id: "r1",
        timestamp: 3,
        type: "reasoning",
        content: `我看到 ${secret}，不能说出来`,
        rawContent: secret,
        sessionId: SESSION,
        cwd: CWD,
      }),
      // A message row whose content mixes text with tool items.
      JSON.stringify({
        id: "a1",
        timestamp: 4,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          // `text` is populated on purpose: the item-type whitelist has to be the
          // thing that keeps these out, not the absence of a text field.
          {
            type: "tool_use",
            name: "read_file",
            text: "read_file /Users/michael/secret/.env",
            input: { path: "/Users/michael/secret/.env" },
          },
          {
            type: "tool_result",
            text: `OPENAI_API_KEY=${secret}`,
            content: `OPENAI_API_KEY=${secret}`,
          },
          { type: "thinking", text: `我看到 ${secret}，不能说出来` },
          { type: "output_text", text: "文件里有一个密钥，我不会把它贴出来。" },
        ],
        sessionId: SESSION,
        cwd: CWD,
      }),
      // A user row with an image attachment beside the text.
      JSON.stringify({
        id: "u2",
        timestamp: 5,
        type: "message",
        role: "user",
        content: [
          {
            type: "image_blob_ref",
            blob_id: "5e45b44ec33af3cd",
            mime: "image/jpeg",
            text: "/Users/michael/.workbuddy/blobs/5e/5e45b44ec33af3cd.jpg",
            blob_path: "/Users/michael/.workbuddy/blobs/5e/5e45b44ec33af3cd.jpg",
          },
          { type: "input_text", text: "<user_query>这张图什么意思</user_query>" },
        ],
        sessionId: SESSION,
        cwd: CWD,
      }),
      assistantRow("a2", "这是一张架构图。"),
      // An untagged user row: the fallback path must still ignore the blob item.
      JSON.stringify({
        id: "u3",
        timestamp: 6,
        type: "message",
        role: "user",
        content: [
          {
            type: "image_blob_ref",
            blob_id: "aa11",
            text: "/Users/michael/.workbuddy/blobs/aa/aa11.jpg",
            blob_path: "/Users/michael/.workbuddy/blobs/aa/aa11.jpg",
          },
          { type: "input_text", text: "再看这张" },
        ],
        sessionId: SESSION,
        cwd: CWD,
      }),
      assistantRow("a3", "这是时序图。"),
    );

    const parsed = parseTranscriptTail(body);
    const serialised = JSON.stringify(parsed.turns);

    expect(parsed.turns).toHaveLength(3);
    expect(parsed.turns[2]).toMatchObject({ promptText: "再看这张", replyText: "这是时序图。" });
    expect(parsed.turns[0].replyText).toBe("文件里有一个密钥，我不会把它贴出来。");
    expect(parsed.turns[1]).toMatchObject({
      promptText: "这张图什么意思",
      replyText: "这是一张架构图。",
    });
    for (const forbidden of [
      secret,
      "OPENAI_API_KEY",
      "DATABASE_URL",
      "/Users/michael/secret/.env",
      "blob_path",
      ".workbuddy/blobs",
      "tool_use",
      "tool_result",
      "read_file",
      "不能说出来",
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  test("keeps an auto-retry continuation inside the round it belongs to", () => {
    const body = lines(
      userRow("u1", "帮我调研一下"),
      assistantRow("a1", "我先搜索……"),
      JSON.stringify({
        id: "u-retry",
        timestamp: 9,
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: '<system-reminder data-role="error-recovery">Stream timeout occurred. Please continue where you left off.</system-reminder>',
          },
        ],
        sessionId: SESSION,
        cwd: CWD,
      }),
      assistantRow("a2", "接着说：结论是三家可用。"),
    );

    const parsed = parseTranscriptTail(body);

    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].promptText).toBe("帮我调研一下");
    expect(parsed.turns[0].replyText).toBe("我先搜索……\n\n接着说：结论是三家可用。");
    expect(JSON.stringify(parsed.turns)).not.toContain("system-reminder");
  });

  test("does not emit a trailing round that has no reply yet", () => {
    const body = lines(
      userRow("u1", "第一个问题"),
      assistantRow("a1", "第一个回答"),
      userRow("u2", "还没被回答的问题"),
    );

    const parsed = parseTranscriptTail(body);

    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].userMessageId).toBe("u1");
  });

  test("skips assistant text that has no owning user message", () => {
    const body = lines(
      assistantRow("a0", "上一轮的尾巴"),
      userRow("u1", "新问题"),
      assistantRow("a1", "新回答"),
    );

    const parsed = parseTranscriptTail(body);

    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].replyText).toBe("新回答");
  });

  test("skips unparseable and empty lines in the middle without failing", () => {
    const body = lines(
      userRow("u1", "问题"),
      "{not json at all",
      "",
      JSON.stringify({ id: "x", type: "file-history-snapshot", snapshot: { files: ["a.ts"] } }),
      JSON.stringify({
        id: "s",
        type: "message",
        role: "system",
        content: [{ type: "text", text: "系统提示" }],
      }),
      JSON.stringify({
        id: "e",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [],
      }),
      assistantRow("a1", "回答"),
    );

    const parsed = parseTranscriptTail(body);

    expect(parsed.droppedLeadingPartial).toBe(false);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].replyText).toBe("回答");
    expect(JSON.stringify(parsed.turns)).not.toContain("系统提示");
  });

  test("reads the session title from ai-title and custom-title rows", () => {
    const withAiTitle = parseTranscriptTail(
      lines(
        JSON.stringify({
          timestamp: 1,
          type: "ai-title",
          aiTitle: "创建查找 Codex 对话记录的 Skill",
          sessionId: SESSION,
          cwd: CWD,
        }),
        userRow("u1", "问题"),
        assistantRow("a1", "回答"),
      ),
    );
    expect(withAiTitle.sessionTitle).toBe("创建查找 Codex 对话记录的 Skill");
    expect(withAiTitle.sessionId).toBe(SESSION);
    expect(withAiTitle.cwd).toBe(CWD);

    const withCustomTitle = parseTranscriptTail(
      lines(
        JSON.stringify({
          id: "t",
          timestamp: 1,
          type: "custom-title",
          customTitle: "我改的标题",
          sessionId: SESSION,
        }),
        userRow("u1", "问题"),
        assistantRow("a1", "回答"),
      ),
    );
    expect(withCustomTitle.sessionTitle).toBe("我改的标题");
  });

  test("returns an empty result for empty input", () => {
    for (const input of ["", Buffer.alloc(0)]) {
      expect(parseTranscriptTail(input)).toMatchObject({
        turns: [],
        droppedLeadingPartial: false,
        droppedTrailingPartial: false,
      });
    }
  });
});

describe("extractUserQuery", () => {
  test("returns only the tagged query, dropping the reminder block", () => {
    const raw =
      '<system-reminder data-role="user-context">\n<user_info>OS: darwin</user_info>\n' +
      "</system-reminder>\n<user_query>这个 skill 的名字是什么</user_query>";

    expect(extractUserQuery(raw)).toBe("这个 skill 的名字是什么");
    expect(extractUserQuery(raw)).not.toContain("system-reminder");
  });

  test("falls back to the whole text when the tag is absent", () => {
    expect(extractUserQuery("  没有标签的纯文本  ")).toBe("没有标签的纯文本");
  });

  test("uses the last query when a compacted message replays earlier ones", () => {
    // Measured shape: 3 of 537 real user rows carry several <user_query> blocks.
    const raw =
      "<cb_summary><user_query>\n旧的问题\n</user_query>" +
      "<previous_assistant_message>旧的回答</previous_assistant_message></cb_summary>\n" +
      "<user_query>你用 codex 对话记录的 skill 搜一下</user_query>";

    expect(extractUserQuery(raw)).toBe("你用 codex 对话记录的 skill 搜一下");
  });

  test("handles multiline queries", () => {
    expect(extractUserQuery("<user_query>\n第一行\n第二行\n</user_query>")).toBe("第一行\n第二行");
  });

  test("strips injected reminder blocks from untagged fallback text", () => {
    // Older sessions have no <user_query> wrapper but still carry the injected
    // identity block. Uploading SOUL.md / USER.md verbatim would be a leak.
    const raw =
      '<system-reminder data-role="user-context">\n## SOUL.md\nPath: /Users/michael/.workbuddy/SOUL.md\n' +
      "秘密的身份描述\n</system-reminder>\n我的调研工作流是什么样的？";

    const extracted = extractUserQuery(raw);

    expect(extracted).toBe("我的调研工作流是什么样的？");
    expect(extracted).not.toContain("SOUL.md");
    expect(extracted).not.toContain("秘密的身份描述");
  });

  test("returns nothing for a reminder-only auto-retry row", () => {
    // Measured: 8 real user rows are exactly this and nothing else.
    expect(
      extractUserQuery(
        '<system-reminder data-role="error-recovery">Stream timeout occurred. ' +
          "Please continue where you left off.</system-reminder>",
      ),
    ).toBe("");
  });
});

/** Records the exact byte ranges readSessionTitle asks for. */
function recordingFs(content: Buffer) {
  const reads: Array<{ position: number; length: number }> = [];
  return {
    reads,
    async open() {
      return {
        async stat() {
          return { isFile: () => true, size: content.length };
        },
        async read(buffer: Buffer, offset: number, length: number, position: number) {
          reads.push({ position, length });
          const slice = content.subarray(position, position + length);
          slice.copy(buffer, offset);
          return { bytesRead: slice.length };
        },
        async close() {
          return undefined;
        },
      };
    },
  };
}

function titleRow(title: string): string {
  return JSON.stringify({ timestamp: 1, type: "ai-title", aiTitle: title, sessionId: SESSION });
}

function padTo(byteLength: number): string {
  const row = `${JSON.stringify({ id: "f", type: "function_call_result", output: "填".repeat(200) })}\n`;
  let out = "";
  while (Buffer.byteLength(out, "utf8") + Buffer.byteLength(row, "utf8") <= byteLength) out += row;
  const remaining = byteLength - Buffer.byteLength(out, "utf8");
  return out + "x".repeat(Math.max(0, remaining - 1)) + (remaining > 0 ? "\n" : "");
}

describe("readSessionTitle bounded view", () => {
  test("reads the whole file once when it fits inside the tail window", async () => {
    const body = `${titleRow("短会话标题")}\n${userRow("u1", "问题")}\n${assistantRow("a1", "回答")}\n`;
    const fs = recordingFs(Buffer.from(body, "utf8"));

    await expect(readSessionTitle(fs, "/x.jsonl")).resolves.toBe("短会话标题");

    // Head range would re-read bytes the tail already covered, so it is skipped.
    expect(fs.reads).toHaveLength(1);
    expect(fs.reads[0]).toEqual({ position: 0, length: Buffer.byteLength(body, "utf8") });
  });

  test("finds a head-only title on a long file without reading a newer tail", async () => {
    const head = `${titleRow("只在文件头出现的标题")}\n`;
    const content = Buffer.from(head + padTo(TITLE_TAIL_BYTES), "utf8");
    const fs = recordingFs(content);

    await expect(readSessionTitle(fs, "/x.jsonl")).resolves.toBe("只在文件头出现的标题");

    expect(fs.reads).toEqual([{ position: 0, length: TITLE_HEAD_BYTES }]);
  });

  test("keeps the first title after a later custom rename", async () => {
    const head = `${titleRow("头部的旧标题")}\n`;
    const tail =
      padTo(TITLE_TAIL_BYTES - 200) +
      `${JSON.stringify({ id: "t", timestamp: 9, type: "custom-title", customTitle: "用户改的新标题" })}\n`;
    const fs = recordingFs(Buffer.from(head + tail, "utf8"));

    await expect(readSessionTitle(fs, "/x.jsonl")).resolves.toBe("头部的旧标题");
    expect(fs.reads).toHaveLength(1);
    expect(fs.reads[0]).toEqual({ position: 0, length: TITLE_HEAD_BYTES });
  });

  test("finds an initial title beyond 64 KiB instead of a later tail rename", async () => {
    const beforeInitialTitle = padTo(TITLE_HEAD_BYTES + 4 * 1_024);
    const initialTitle = `${titleRow("64KiB 之后的最初标题")}\n`;
    const afterInitialTitle = padTo(TITLE_TAIL_BYTES + 4 * 1_024);
    const laterRename = `${JSON.stringify({
      type: "custom-title",
      customTitle: "尾部重命名不能改变已发送事件",
    })}\n`;
    const content = Buffer.from(
      beforeInitialTitle + initialTitle + afterInitialTitle + laterRename,
      "utf8",
    );
    const fs = recordingFs(content);

    await expect(readSessionTitle(fs, "/x.jsonl")).resolves.toBe("64KiB 之后的最初标题");

    expect(Buffer.byteLength(beforeInitialTitle, "utf8")).toBeGreaterThan(TITLE_HEAD_BYTES);
    expect(
      content.length - Buffer.byteLength(beforeInitialTitle + initialTitle, "utf8"),
    ).toBeGreaterThan(TITLE_TAIL_BYTES);
    expect(fs.reads[0]).toEqual({ position: 0, length: TITLE_HEAD_BYTES });
    expect(fs.reads[1]).toEqual({ position: TITLE_HEAD_BYTES, length: TITLE_HEAD_BYTES });
  });

  test("drops a head line that the byte boundary left unterminated", async () => {
    // The second title row is followed by filler without a newline, so it is not
    // a complete JSONL row even though its closing brace is present.
    const headRegion = `${titleRow("第一个标题")}\n${titleRow("边界上的标题")}`;
    const content = Buffer.from(headRegion + padTo(TITLE_TAIL_BYTES), "utf8");
    const fs = recordingFs(content);

    await expect(readSessionTitle(fs, "/x.jsonl")).resolves.toBe("第一个标题");

    expect(fs.reads[0]).toEqual({ position: 0, length: TITLE_HEAD_BYTES });
  });

  test("returns null without re-reading the same bytes as a head window", async () => {
    // Titleless AND small: the tail covered the whole file, so there is no head
    // range left to read. This is the guard against double-counting content.
    const body = `${userRow("u1", "问题")}\n${assistantRow("a1", "回答")}\n`;
    const fs = recordingFs(Buffer.from(body, "utf8"));

    await expect(readSessionTitle(fs, "/x.jsonl")).resolves.toBeNull();
    expect(fs.reads).toHaveLength(1);
    expect(fs.reads[0]).toEqual({ position: 0, length: Buffer.byteLength(body, "utf8") });

    const empty = recordingFs(Buffer.alloc(0));
    await expect(readSessionTitle(empty, "/x.jsonl")).resolves.toBeNull();
    expect(empty.reads).toHaveLength(0);
  });

  test("findSessionTitle takes the first complete title row", () => {
    expect(findSessionTitle(`${titleRow("A")}\n${titleRow("B")}\n`)).toBe("A");
    expect(findSessionTitle(`${titleRow("A")}\nnot json\n`)).toBe("A");
    expect(
      findSessionTitle(`${JSON.stringify({ type: "ai-title", aiTitle: "   " })}\n`),
    ).toBeNull();
    expect(findSessionTitle("")).toBeNull();
  });
});

describe("resolveSessionTitle and buildTurnEvent", () => {
  test("prefers the transcript title, then the cwd basename, then the constant", () => {
    expect(resolveSessionTitle("真标题", CWD)).toBe("真标题");
    expect(resolveSessionTitle(null, CWD)).toBe("2026-07-25-17-46-47");
    expect(resolveSessionTitle("   ", "C:\\Users\\camp\\projects\\demo\\")).toBe("demo");
    expect(resolveSessionTitle(null, null)).toBe("WorkBuddy 会话");
  });

  test("shapes a turn into a contract-valid event and never drops oversized content", () => {
    const turn = {
      userMessageId: "u1",
      promptText: "问".repeat(5_000),
      replyText: "答".repeat(20_000),
      userTimestamp: 1_784_972_810_066,
    };

    const event = buildTurnEvent({
      turn,
      sourceSessionKey: SESSION,
      sessionTitle: null,
      cwd: CWD,
      eventId: deriveEventId(SESSION, "u1"),
    });

    expect(event).not.toBeNull();
    expect(event!.source).toBe("connector");
    expect(event!.source_session_key).toBe(SESSION);
    expect(event!.session_title).toBe("2026-07-25-17-46-47");
    expect(event!.prompt.length).toBeLessThanOrEqual(4_000);
    expect(event!.reply.length).toBeLessThanOrEqual(8_000);
    expect(event!.prompt).toContain("[…内容超出上限已截断]");
    expect(event!.reply).toContain("[…内容超出上限已截断]");
    expect(event!.prompt.startsWith("问问问")).toBe(true);
    expect(event!.client_created_at).toBe("2026-07-25T09:46:50.066Z");
  });

  test("refuses to build an event when there is nothing to say", () => {
    expect(
      buildTurnEvent({
        turn: { userMessageId: "u1", promptText: "   ", replyText: "答", userTimestamp: null },
        sourceSessionKey: SESSION,
        sessionTitle: null,
        cwd: CWD,
        eventId: deriveEventId(SESSION, "u1"),
      }),
    ).toBeNull();
  });

  test("omits an out-of-range timestamp instead of aborting the event", () => {
    let event: ReturnType<typeof buildTurnEvent> = null;
    expect(() => {
      event = buildTurnEvent({
        turn: {
          userMessageId: "u1",
          promptText: "问题",
          replyText: "回答",
          userTimestamp: 8_640_000_000_000_001,
        },
        sourceSessionKey: SESSION,
        sessionTitle: "标题",
        cwd: CWD,
        eventId: deriveEventId(SESSION, "u1"),
      });
    }).not.toThrow();
    expect(event).toEqual({
      event_id: deriveEventId(SESSION, "u1"),
      source: "connector",
      source_session_key: SESSION,
      session_title: "标题",
      prompt: "问题",
      reply: "回答",
    });
  });
});

const realProjects = join(homedir(), ".workbuddy", "projects");
function realSessionFiles(): string[] {
  try {
    const files: string[] = [];
    for (const entry of readdirSync(realProjects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of readdirSync(join(realProjects, entry.name))) {
        if (name.endsWith(".jsonl")) files.push(join(realProjects, entry.name, name));
      }
    }
    return files;
  } catch {
    return [];
  }
}

describe("real WorkBuddy transcripts on this machine", () => {
  const files = realSessionFiles();

  test.skipIf(files.length === 0)("every extracted turn satisfies the server contract", () => {
    let turns = 0;
    const eventIds = new Set<string>();
    for (const path of files.slice(0, 60)) {
      if (statSync(path).size > 8 * 1024 * 1024) continue;
      const sessionId = path
        .split("/")
        .pop()!
        .replace(/\.jsonl$/, "");
      const parsed = parseTranscriptTail(readFileSync(path));
      for (const turn of parsed.turns) {
        const eventId = deriveEventId(sessionId, turn.userMessageId);
        const event = buildTurnEvent({
          turn,
          sourceSessionKey: sessionId,
          sessionTitle: parsed.sessionTitle,
          cwd: parsed.cwd,
          eventId,
        });
        expect(event).not.toBeNull();
        expect(event!.prompt.trim().length).toBeGreaterThan(0);
        expect(event!.reply.trim().length).toBeGreaterThan(0);
        expect(event!.prompt.length).toBeLessThanOrEqual(4_000);
        expect(event!.reply.length).toBeLessThanOrEqual(8_000);
        expect(event!.session_title.length).toBeLessThanOrEqual(120);
        expect(event!.source_session_key.length).toBeLessThanOrEqual(255);
        expect(event!.prompt).not.toContain("<system-reminder");
        expect(eventIds.has(eventId)).toBe(false);
        eventIds.add(eventId);
        turns += 1;
      }
    }
    expect(turns).toBeGreaterThan(0);
  });
});
