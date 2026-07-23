import { describe, expect, test, vi } from "vitest";

import {
  createWebSeenVisibilityController,
  type VisibilityObserverEntry,
} from "@/lib/web-seen-visibility";

const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";

function setup(role: "student" | "mentor", initiallyVisible = true) {
  let documentVisible = initiallyVisible;
  let observerCallback: (entries: VisibilityObserverEntry[]) => void = () => {};
  const observed = new Set<object>();
  const disconnect = vi.fn();
  const markSeen = vi.fn(async (_ids: string[]) => {});
  const controller = createWebSeenVisibilityController({
    role,
    sessionId: SESSION_ID,
    isDocumentVisible: () => documentVisible,
    markSeen,
    createObserver(callback, options) {
      observerCallback = callback;
      expect(options.threshold).toBe(0.5);
      return {
        observe: (element) => observed.add(element),
        unobserve: (element) => observed.delete(element),
        disconnect,
      };
    },
  });
  return {
    controller,
    markSeen,
    observed,
    disconnect,
    emit: (entries: VisibilityObserverEntry[]) => observerCallback(entries),
    setDocumentVisible(value: boolean) {
      documentVisible = value;
      controller.handleDocumentVisibility();
    },
  };
}

describe("web-seen visibility", () => {
  test("marks only a sufficiently visible mentor card in a visible document, once", async () => {
    const view = setup("student");
    const element = {};
    view.controller.observe(
      { messageId: MESSAGE_ID, sessionId: SESSION_ID, kind: "mentor" },
      element,
    );
    expect(view.observed.has(element)).toBe(true);

    view.emit([{ target: element, isIntersecting: true, intersectionRatio: 0.49 }]);
    await Promise.resolve();
    expect(view.markSeen).not.toHaveBeenCalled();

    view.emit([{ target: element, isIntersecting: true, intersectionRatio: 0.5 }]);
    await Promise.resolve();
    expect(view.markSeen).toHaveBeenCalledWith([MESSAGE_ID]);

    view.emit([{ target: element, isIntersecting: true, intersectionRatio: 1 }]);
    await Promise.resolve();
    expect(view.markSeen).toHaveBeenCalledTimes(1);
  });

  test("defers hidden cards until the document becomes visible and cleans up", async () => {
    const view = setup("student", false);
    const element = {};
    view.controller.observe(
      { messageId: MESSAGE_ID, sessionId: SESSION_ID, kind: "mentor" },
      element,
    );
    view.emit([{ target: element, isIntersecting: true, intersectionRatio: 1 }]);
    await Promise.resolve();
    expect(view.markSeen).not.toHaveBeenCalled();

    view.setDocumentVisible(true);
    await Promise.resolve();
    expect(view.markSeen).toHaveBeenCalledWith([MESSAGE_ID]);

    view.controller.stop();
    expect(view.disconnect).toHaveBeenCalledOnce();
  });

  test("never marks offscreen, foreign-session, non-mentor, or mentor-view cards", async () => {
    const student = setup("student");
    const offscreen = {};
    const foreign = {};
    const reply = {};
    student.controller.observe(
      { messageId: MESSAGE_ID, sessionId: SESSION_ID, kind: "mentor" },
      offscreen,
    );
    student.controller.observe(
      {
        messageId: "40000000-0000-4000-8000-000000000002",
        sessionId: "30000000-0000-4000-8000-000000000002",
        kind: "mentor",
      },
      foreign,
    );
    student.controller.observe(
      {
        messageId: "40000000-0000-4000-8000-000000000003",
        sessionId: SESSION_ID,
        kind: "reply",
      },
      reply,
    );
    student.emit([
      { target: offscreen, isIntersecting: false, intersectionRatio: 0 },
      { target: foreign, isIntersecting: true, intersectionRatio: 1 },
      { target: reply, isIntersecting: true, intersectionRatio: 1 },
    ]);
    await Promise.resolve();
    expect(student.markSeen).not.toHaveBeenCalled();

    const mentor = setup("mentor");
    const mentorElement = {};
    mentor.controller.observe(
      { messageId: MESSAGE_ID, sessionId: SESSION_ID, kind: "mentor" },
      mentorElement,
    );
    mentor.emit([{ target: mentorElement, isIntersecting: true, intersectionRatio: 1 }]);
    await Promise.resolve();
    expect(mentor.markSeen).not.toHaveBeenCalled();
  });
});
