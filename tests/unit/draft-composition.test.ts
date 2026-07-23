import { describe, expect, test, vi } from "vitest";

import { createComposeRevisionController } from "@/lib/draft-composition";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  let text = "existing note";
  let sessionId = "30000000-0000-4000-8000-000000000001";
  const discarded = vi.fn();
  const controller = createComposeRevisionController({
    readText: () => text,
    readSessionId: () => sessionId,
    applyDraft: (draft) => {
      text = draft;
    },
    onDiscard: discarded,
  });
  return {
    controller,
    discarded,
    text: () => text,
    edit(value: string) {
      controller.noteUserChange();
      text = value;
    },
    switchSession(value: string) {
      controller.invalidateSession();
      sessionId = value;
    },
  };
}

describe("AI draft compose revision", () => {
  test("an unchanged draft in the same session is applied", async () => {
    const view = setup();

    await expect(
      view.controller.requestDraft(
        async () => ({ draft: "current AI draft" }),
        (result) => result.draft,
      ),
    ).resolves.toMatchObject({ applied: true, stale: false });
    expect(view.text()).toBe("current AI draft");
    expect(view.discarded).not.toHaveBeenCalled();
  });

  test("a late draft cannot overwrite text edited while generation is pending", async () => {
    const view = setup();
    const request = deferred<{ draft: string }>();
    const pending = view.controller.requestDraft(
      () => request.promise,
      (result) => result.draft,
    );

    view.edit("my newer edit");
    request.resolve({ draft: "late AI draft" });

    await expect(pending).resolves.toMatchObject({ applied: false, stale: true });
    expect(view.text()).toBe("my newer edit");
    expect(view.discarded).toHaveBeenCalledOnce();
  });

  test("manual send start or success invalidates an older AI draft", async () => {
    const view = setup();
    const request = deferred<{ draft: string }>();
    const pending = view.controller.requestDraft(
      () => request.promise,
      (result) => result.draft,
    );

    view.controller.noteManualSendStart();
    view.controller.noteManualSendSuccess();
    request.resolve({ draft: "late AI draft" });

    await expect(pending).resolves.toMatchObject({ applied: false, stale: true });
    expect(view.text()).toBe("existing note");
  });

  test("a draft from the previous session is discarded", async () => {
    const view = setup();
    const request = deferred<{ draft: string }>();
    const pending = view.controller.requestDraft(
      () => request.promise,
      (result) => result.draft,
    );

    view.switchSession("30000000-0000-4000-8000-000000000002");
    request.resolve({ draft: "draft for the old session" });

    await expect(pending).resolves.toMatchObject({ applied: false, stale: true });
    expect(view.text()).toBe("existing note");
  });

  test("a failed draft request never changes the current input", async () => {
    const view = setup();

    await expect(
      view.controller.requestDraft(
        async () => {
          throw new Error("provider failed");
        },
        () => "unreachable",
      ),
    ).rejects.toThrow("provider failed");
    expect(view.text()).toBe("existing note");
  });
});
