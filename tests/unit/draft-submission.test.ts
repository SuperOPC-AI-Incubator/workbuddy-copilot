import { describe, expect, test, vi } from "vitest";

import { createDraftSubmissionController } from "@/lib/draft-submission";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("draft submission controller", () => {
  test("is single-flight and clears only an unchanged successful draft", async () => {
    let draft = "captured";
    const busy = vi.fn();
    const pending = deferred<{ ok: boolean }>();
    const send = vi.fn(async () => pending.promise);
    const controller = createDraftSubmissionController({
      readDraft: () => draft,
      clearDraft: () => {
        draft = "";
      },
      onBusyChange: busy,
    });

    const first = controller.submit(send, (result) => result.ok);
    const duplicate = await controller.submit(send, (result) => result.ok);
    expect(duplicate).toEqual({ started: false });
    expect(send).toHaveBeenCalledTimes(1);

    pending.resolve({ ok: true });
    await first;
    expect(draft).toBe("");
    expect(busy).toHaveBeenNthCalledWith(1, true);
    expect(busy).toHaveBeenLastCalledWith(false);
  });

  test("old success and old failure never overwrite a draft edited while pending", async () => {
    let draft = "captured";
    const first = deferred<{ ok: boolean }>();
    const controller = createDraftSubmissionController({
      readDraft: () => draft,
      clearDraft: () => {
        draft = "";
      },
    });

    const success = controller.submit(
      () => first.promise,
      (result) => result.ok,
    );
    draft = "new user edit";
    first.resolve({ ok: true });
    await success;
    expect(draft).toBe("new user edit");

    const failure = deferred<{ ok: boolean }>();
    const failed = controller.submit(
      () => failure.promise,
      (result) => result.ok,
    );
    draft = "newer user edit";
    failure.reject(new Error("old request failed"));
    const outcome = await failed;
    expect(outcome).toMatchObject({ started: true, succeeded: false });
    expect(draft).toBe("newer user edit");
  });

  test("invalidate prevents an old request from clearing or releasing a newer request", async () => {
    let draft = "old";
    const oldRequest = deferred<{ ok: boolean }>();
    const newRequest = deferred<{ ok: boolean }>();
    const controller = createDraftSubmissionController({
      readDraft: () => draft,
      clearDraft: () => {
        draft = "";
      },
    });
    const old = controller.submit(
      () => oldRequest.promise,
      (result) => result.ok,
    );
    controller.invalidate();
    draft = "new";
    const newer = controller.submit(
      () => newRequest.promise,
      (result) => result.ok,
    );
    oldRequest.resolve({ ok: true });
    await old;
    expect(draft).toBe("new");

    await expect(
      controller.submit(
        async () => ({ ok: true }),
        (result) => result.ok,
      ),
    ).resolves.toEqual({ started: false });
    newRequest.resolve({ ok: true });
    await newer;
    expect(draft).toBe("");
  });
});
