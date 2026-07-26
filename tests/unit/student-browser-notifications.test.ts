import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import {
  createStudentBrowserNotificationController,
  type BrowserNotificationPort,
} from "@/lib/student-browser-notifications";

const OWN_SESSION_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_SESSION_ID = "30000000-0000-4000-8000-000000000002";

function item(
  overrides: Partial<{
    id: string;
    sessionId: string;
    kind: "prompt" | "reply" | "diagnosis" | "mentor";
    text: string;
    severity: "ok" | "warn" | "error" | null;
  }> = {},
) {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    sessionId: OWN_SESSION_ID,
    kind: "mentor" as const,
    text: "请先检查配置。",
    severity: null,
    ...overrides,
  };
}

function setup({
  permission = "default",
  messageVisible = false,
  ownedSessionIds = [OWN_SESSION_ID],
}: {
  permission?: "default" | "granted" | "denied";
  messageVisible?: boolean;
  ownedSessionIds?: string[];
} = {}) {
  let currentPermission = permission;
  let requestedPermission = permission;
  const statusChanges = vi.fn();
  const port: BrowserNotificationPort = {
    getPermission: vi.fn(() => currentPermission),
    requestPermission: vi.fn(async () => {
      currentPermission = requestedPermission;
      return currentPermission;
    }),
    send: vi.fn(),
  };
  const controller = createStudentBrowserNotificationController({
    notifications: port,
    isMessageVisible: () => messageVisible,
    ownsSession: (sessionId) => ownedSessionIds.includes(sessionId),
    onStatusChange: statusChanges,
  });
  return {
    controller,
    port,
    statusChanges,
    setPermission(next: "default" | "granted" | "denied") {
      currentPermission = next;
    },
    setRequestedPermission(next: "default" | "granted" | "denied") {
      requestedPermission = next;
    },
  };
}

describe("student browser notifications", () => {
  test("shows 未开启 and never calls the notification API before permission is granted", () => {
    const view = setup();

    expect(view.controller.getStatus()).toMatchObject({
      state: "default",
      label: "未开启",
      canRequest: true,
    });

    view.controller.handleTimelineInsert(item());

    expect(view.port.requestPermission).not.toHaveBeenCalled();
    expect(view.port.send).not.toHaveBeenCalled();
  });

  test("shows an actionable browser-settings instruction after permission is denied", () => {
    const view = setup({ permission: "denied" });

    expect(view.controller.getStatus()).toMatchObject({
      state: "denied",
      label: "已拒绝",
      canRequest: false,
    });
    expect(view.controller.getStatus().guidance).toContain("浏览器地址栏");

    view.controller.handleTimelineInsert(item());
    expect(view.port.send).not.toHaveBeenCalled();
  });

  test("requests permission only when the explicit user action invokes it", async () => {
    const view = setup();
    view.setRequestedPermission("granted");

    await view.controller.requestPermission();

    expect(view.port.requestPermission).toHaveBeenCalledOnce();
    expect(view.controller.getStatus()).toMatchObject({ state: "granted", label: "已开启" });
  });

  test("notifies once for an owned mentor message while the page is in the background", () => {
    const view = setup({ permission: "granted" });
    const message = item();

    view.controller.handleTimelineInsert(message);
    view.controller.handleTimelineInsert(message);

    expect(view.port.send).toHaveBeenCalledOnce();
    expect(view.port.send).toHaveBeenCalledWith({
      title: "导师发来消息",
      body: message.text,
      tag: `student-${message.id}`,
    });
  });

  test("notifies for an owned error diagnosis", () => {
    const view = setup({ permission: "granted" });

    view.controller.handleTimelineInsert(
      item({ id: "40000000-0000-4000-8000-000000000003", kind: "diagnosis", severity: "error" }),
    );

    expect(view.port.send).toHaveBeenCalledWith({
      title: "学习诊断需要关注",
      body: "请先检查配置。",
      tag: "student-40000000-0000-4000-8000-000000000003",
    });
  });

  test("never notifies for another student's session even if Realtime delivers the row", () => {
    const view = setup({ permission: "granted" });

    view.controller.handleTimelineInsert(item({ sessionId: OTHER_SESSION_ID }));

    expect(view.port.send).not.toHaveBeenCalled();
  });

  test("does not interrupt a foreground page that is already showing the message", () => {
    const view = setup({ permission: "granted", messageVisible: true });

    view.controller.handleTimelineInsert(item());

    expect(view.port.send).not.toHaveBeenCalled();
  });

  test("still notifies an owned background-session message while another conversation is visible", () => {
    const view = setup({
      permission: "granted",
      messageVisible: false,
      ownedSessionIds: [OWN_SESSION_ID, OTHER_SESSION_ID],
    });

    view.controller.handleTimelineInsert(
      item({
        id: "40000000-0000-4000-8000-000000000004",
        sessionId: OTHER_SESSION_ID,
      }),
    );

    expect(view.port.send).toHaveBeenCalledOnce();
  });

  test("reports a browser notification construction failure instead of throwing silently", () => {
    const view = setup({ permission: "granted" });
    view.port.send = vi.fn(() => {
      throw new Error("NOTIFICATION_CONSTRUCTION_FAILED");
    });

    expect(() => view.controller.handleTimelineInsert(item())).not.toThrow();
    expect(view.controller.getStatus()).toMatchObject({
      state: "error",
      label: "通知异常",
    });
    expect(view.statusChanges).toHaveBeenCalledWith(expect.objectContaining({ state: "error" }));
  });

  test("wires the student-only Realtime subscription to the explicit permission UI", () => {
    const desk = readFileSync(
      resolve(process.cwd(), "src/routes/_authenticated/index.tsx"),
      "utf8",
    );
    const studentNotificationEffect = desk.slice(
      desk.indexOf("// Student browser notifications:"),
      desk.indexOf("// Initial load + realtime for students"),
    );

    expect(desk).toContain("createBrowserNotificationPort");
    expect(desk).toContain("开启消息通知");
    expect(desk).toContain("notificationStatus");
    expect(studentNotificationEffect).toContain('if (role !== "student") return;');
    expect(studentNotificationEffect).toContain('channel("student-browser-notifications")');
    expect(studentNotificationEffect).toContain(
      "ownsSession: (sessionId) => ownSessionIdsRef.current.has(sessionId)",
    );
    expect(desk).toContain("item.session_id === currentSessionIdRef.current");
    expect(studentNotificationEffect).toContain("notifyStudentAboutTimelineItem");
    expect(desk).toContain("handleTimelineInsert");
    expect(desk).toContain("visibleStudentNotificationItemIdsRef.current.has(item.id)");
    expect(desk).toContain("getBoundingClientRect()");
    expect(desk).toContain("timelineViewportRef.current?.getBoundingClientRect()");
    expect(desk).toContain("deferredStudentNotificationItemsRef");
  });

  test("keeps the mentor alert subscription and its existing browser notification branch", () => {
    const desk = readFileSync(
      resolve(process.cwd(), "src/routes/_authenticated/index.tsx"),
      "utf8",
    );
    const mentorAlertEffect = desk.slice(
      desk.indexOf("// Mentor-wide alerts:"),
      desk.indexOf("const dismissAlert"),
    );

    expect(mentorAlertEffect).toContain('if (role !== "mentor") return;');
    expect(mentorAlertEffect).toContain('channel("mentor-alerts")');
    expect(mentorAlertEffect).toContain("getMentorAlertKind(row)");
    expect(mentorAlertEffect).toContain("new Notification(title");
  });
});
