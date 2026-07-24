import { expect, test, type BrowserContext } from "@playwright/test";

import {
  E2E_ENVIRONMENT,
  createE2EHarness,
  loginWithPassword,
  type E2EHarness,
} from "./support/e2e-fixture";

test.describe("authentication and mentor administration", () => {
  test.skip(!E2E_ENVIRONMENT.available, E2E_ENVIRONMENT.skipReason);
  test.describe.configure({ mode: "serial", timeout: 90_000 });

  let harness: E2EHarness;

  test.beforeEach(async () => {
    harness = await createE2EHarness();
  });

  test.afterEach(async () => {
    await test.step("fixture-cleanup", async () => {
      await harness?.cleanup();
    });
  });

  test("public signup exposes no privileged role choice and provisions only a student", async ({
    page,
  }) => {
    const negativeControl = process.env.E2E_NEGATIVE_CONTROL === "signup-role";
    const negativeMarker = negativeControl ? process.env.E2E_NEGATIVE_CONTROL_MARKER : undefined;
    const email = harness.uniqueEmail("signup");
    const displayName = harness.uniqueLabel("公开注册学员");
    harness.trackEmail(email);

    await page.goto("/auth");
    await page.getByRole("button", { name: "注册" }).click();

    await expect(page.getByText("公开注册只会创建学员账号。")).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByLabel("导师")).toHaveCount(0);

    await page.getByLabel("昵称（可选）").fill(displayName);
    await page.getByLabel("学员邮箱").fill(email);
    await page.getByLabel("密码").fill(harness.initialPassword);
    await page.locator("form").getByRole("button", { name: "注册" }).click();

    await expect
      .poll(() => harness.readStudentIdentity(email), {
        message: negativeControl
          ? negativeMarker
          : "student signup must be committed to the local database",
      })
      .toEqual({
        displayName,
        roles: negativeControl ? ["mentor"] : ["student"],
      });
  });

  test("mentor username login is forced through first-password change", async ({ page }) => {
    const negativeControl = process.env.E2E_NEGATIVE_CONTROL === "password-rotation";
    const negativeMarker = negativeControl ? process.env.E2E_NEGATIVE_CONTROL_MARKER : undefined;
    const mentor = await harness.createStaff({
      prefix: "forced",
      mustChangePassword: true,
      teamAdmin: false,
    });

    await loginWithPassword(page, mentor.username, harness.initialPassword);
    await expect(page).toHaveURL(/\/change-password(?:\?|$)/);
    await expect(page.getByRole("heading", { name: "首次登录请修改密码" })).toBeVisible();

    await page.getByLabel("新密码", { exact: true }).fill(harness.newPassword);
    await page.getByLabel("确认新密码").fill(harness.newPassword);
    await page.getByRole("button", { name: "更新密码并继续" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect
      .poll(() => harness.readStaffState(mentor.userId))
      .toMatchObject({ active: true, mustChangePassword: false, roles: ["mentor"] });

    await page.getByRole("button", { name: "退出", exact: true }).click();
    await expect(page).toHaveURL(/\/auth(?:\?|$)/);
    await page.getByLabel("用户名或学员邮箱").fill(mentor.username);
    await page.getByLabel("密码").fill(harness.initialPassword);
    await page.locator("form").getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByText("账号或密码错误", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/auth(?:\?|$)/);

    await page.getByLabel("密码").fill(harness.newPassword);
    await page.locator("form").getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL((url) => url.pathname !== "/auth");
    await expect(page, negativeMarker).toHaveURL(negativeControl ? /\/auth(?:\?|$)/ : /\/$/);
  });

  test("team admin creates and disables a mentor whose existing session then loses read and send", async ({
    browser,
    page,
  }) => {
    const negativeControl = process.env.E2E_NEGATIVE_CONTROL === "disabled-session";
    const negativeMarker = negativeControl ? process.env.E2E_NEGATIVE_CONTROL_MARKER : undefined;
    const { admin, student, seeded, managedUsername } =
      await test.step("fixture-setup", async () => {
        const admin = await harness.createStaff({
          prefix: "admin",
          mustChangePassword: false,
          teamAdmin: true,
        });
        const student = await harness.createStudent("停用权限学员");
        const seeded = await harness.createStudentSession(student, {
          title: harness.uniqueLabel("停用权限会话"),
          prompt: harness.uniqueLabel("停用前可见提示"),
        });
        const managedUsername = harness.uniqueUsername("managed");
        harness.trackMentorUsername(managedUsername);
        return { admin, student, seeded, managedUsername };
      });

    const managedCard = page.locator("article").filter({ hasText: managedUsername });
    const managed = await test.step("admin-create-mentor", async () => {
      await loginWithPassword(page, admin.username, harness.initialPassword);
      await page.goto("/admin/mentors");
      await expect(page.getByRole("heading", { name: "导师账号", exact: true })).toBeVisible();

      await page.getByLabel("用户名").fill(managedUsername);
      await page.getByLabel("临时密码").fill(harness.initialPassword);
      await page.getByRole("button", { name: "创建账号" }).click();
      await expect(page.getByRole("status")).toHaveText(
        "导师账号已创建。临时密码不会在此页面再次显示。",
      );
      await expect(managedCard).toContainText("待首次改密");
      return harness.trackStaffByUsername(managedUsername);
    });

    let mentorContext: BrowserContext | undefined;
    try {
      const mentorPage = await test.step("mentor-context-create", async () => {
        mentorContext = await browser.newContext();
        return mentorContext.newPage();
      });
      await test.step("mentor-password-change", async () => {
        await loginWithPassword(mentorPage, managedUsername, harness.initialPassword);
        await mentorPage.getByLabel("新密码", { exact: true }).fill(harness.newPassword);
        await mentorPage.getByLabel("确认新密码").fill(harness.newPassword);
        await mentorPage.getByRole("button", { name: "更新密码并继续" }).click();
        await expect(mentorPage).toHaveURL(/\/$/);
      });

      await test.step("mentor-read-session", async () => {
        await mentorPage.getByRole("button", { name: student.displayName }).click();
        await mentorPage.getByRole("button", { name: new RegExp(seeded.title) }).click();
        await expect(mentorPage.getByText(seeded.prompt, { exact: true })).toBeVisible();
      });

      await test.step("admin-disable-mentor", async () => {
        page.once("dialog", (dialog) => dialog.accept());
        await managedCard.getByRole("button", { name: "停用账号" }).click();
        await expect(page.getByRole("status")).toHaveText("账号已停用。");
        await expect(managedCard).toContainText("已停用");
      });

      const deniedReply = harness.uniqueLabel("停用后不应发送");
      await test.step("disabled-send-rejected", async () => {
        await mentorPage.getByPlaceholder(/发送导师提示/).fill(deniedReply);
        await mentorPage.getByRole("button", { name: "发送", exact: true }).click();
        await expect(mentorPage.getByRole("alert")).toHaveText("导师消息发送失败，请稍后重试。");
      });
      await test.step("target-assertion", async () => {
        await expect(
          harness.timelineContains(seeded.sessionId, deniedReply),
          negativeMarker,
        ).resolves.toBe(negativeControl);
      });

      await test.step("disabled-session-revoked", async () => {
        await mentorPage.reload();
        await expect(mentorPage).toHaveURL(/\/auth(?:\?|$)/);
        await expect(mentorPage.getByText(seeded.prompt, { exact: true })).toHaveCount(0);
      });
    } finally {
      await test.step("mentor-context-close", async () => {
        await mentorContext?.close();
      });
    }

    await test.step("disabled-state-persisted", async () => {
      await expect(harness.readStaffState(managed.userId)).resolves.toMatchObject({
        active: false,
        mustChangePassword: false,
        roles: ["mentor"],
      });
    });
  });
});
