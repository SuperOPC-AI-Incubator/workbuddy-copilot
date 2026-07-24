import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  createManagementAuthPatch,
  loadTrackedAuthConfiguration,
  parseAuthConfigArguments,
  resolveSupabaseAccessToken,
  syncSupabaseAuthConfig,
} from "../../scripts/configure-supabase-auth.mjs";

const root = process.cwd();
const expectedProjectRef = "hwxbrkvvziqpvsmyllqn";
const expectedSiteUrl = "https://copilot.sg.superbrain-ai.com";

describe("tracked Supabase Auth configuration", () => {
  test("pins the team project and the prototype signup closure without secrets", async () => {
    const config = await loadTrackedAuthConfiguration(root);
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const [gitIgnore, prettierIgnore] = await Promise.all([
      readFile(resolve(root, ".gitignore"), "utf8"),
      readFile(resolve(root, ".prettierignore"), "utf8"),
    ]);

    expect(config).toEqual({
      projectRef: expectedProjectRef,
      siteUrl: expectedSiteUrl,
      additionalRedirectUrls: [`${expectedSiteUrl}/`],
      enableSignup: true,
      email: {
        enableSignup: true,
        enableConfirmations: false,
      },
    });
    expect(packageJson.scripts?.["supabase:auth:plan"]).toBe(
      "node scripts/configure-supabase-auth.mjs",
    );
    expect(JSON.stringify(packageJson.scripts)).not.toContain("supabase config push");
    for (const generatedPath of ["supabase/.temp/", "supabase/.branches/"]) {
      expect(gitIgnore).toContain(generatedPath);
      expect(prettierIgnore).toContain(generatedPath);
    }

    const trackedFiles = await Promise.all([
      readFile(resolve(root, "supabase/config.toml"), "utf8"),
      readFile(resolve(root, "supabase/auth.production.json"), "utf8"),
      readFile(resolve(root, "scripts/configure-supabase-auth.mjs"), "utf8"),
      readFile(resolve(root, "docs/deployment.md"), "utf8"),
      readFile(resolve(root, "docs/research/2026-07-24-supabase-hosted-auth-config.md"), "utf8"),
    ]);
    const trackedText = trackedFiles.join("\n");
    expect(trackedText).not.toMatch(
      /(?:service_role|anon_key|publishable_key|access_token|password)\s*[:=]\s*["'][^"']+/i,
    );
    expect(trackedText).not.toMatch(/sbp_(?:oauth_)?[a-f0-9]{40}/);
    expect(trackedText).not.toMatch(/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/);
    expect(trackedText).not.toMatch(/postgres(?:ql)?:\/\/[^/\s:]+:[^@\s]+@/i);
  });

  test("maps only the five reviewed Management API fields and preserves unrelated remote settings", () => {
    const desired = {
      projectRef: expectedProjectRef,
      siteUrl: expectedSiteUrl,
      additionalRedirectUrls: [`${expectedSiteUrl}/`],
      enableSignup: true,
      email: {
        enableSignup: true,
        enableConfirmations: false,
      },
    };
    const remote = {
      site_url: "http://localhost:3000",
      uri_allow_list: "",
      disable_signup: true,
      external_email_enabled: false,
      mailer_autoconfirm: false,
      password_min_length: 14,
      smtp_host: "unrelated.example",
    };

    expect(createManagementAuthPatch(desired, remote)).toEqual({
      site_url: expectedSiteUrl,
      uri_allow_list: `${expectedSiteUrl}/`,
      disable_signup: false,
      external_email_enabled: true,
      mailer_autoconfirm: true,
    });
  });

  test("defaults to a read-only plan and never sends PATCH", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const result = await syncSupabaseAuthConfig({
      root,
      accessToken: "test-only-token",
      apply: false,
      fetchImpl: async (input, init) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(input),
        });
        return Response.json({
          site_url: "http://localhost:3000",
          uri_allow_list: "",
          disable_signup: true,
          external_email_enabled: false,
          mailer_autoconfirm: false,
        });
      },
    });

    expect(calls).toEqual([
      {
        method: "GET",
        url: `https://api.supabase.com/v1/projects/${expectedProjectRef}/config/auth`,
      },
    ]);
    expect(result).toMatchObject({
      applied: false,
      projectRef: expectedProjectRef,
      patch: {
        site_url: expectedSiteUrl,
        disable_signup: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("test-only-token");
  });

  test("requires the exact tracked project ref before an apply can reach the network", async () => {
    let fetchCount = 0;

    await expect(
      syncSupabaseAuthConfig({
        root,
        accessToken: "test-only-token",
        apply: true,
        confirmedProjectRef: "bnuofecykdoukjjnqbgx",
        fetchImpl: async () => {
          fetchCount += 1;
          return Response.json({});
        },
      }),
    ).rejects.toThrow("does not match the tracked Supabase project");

    expect(fetchCount).toBe(0);
  });

  test("rejects an explicitly supplied wrong project ref even in plan mode", async () => {
    let fetchCount = 0;

    await expect(
      syncSupabaseAuthConfig({
        root,
        accessToken: "test-only-token",
        apply: false,
        confirmedProjectRef: "bnuofecykdoukjjnqbgx",
        fetchImpl: async () => {
          fetchCount += 1;
          return Response.json({});
        },
      }),
    ).rejects.toThrow("does not match the tracked Supabase project");

    expect(fetchCount).toBe(0);
  });

  test("applies only the reviewed diff and verifies the remote state", async () => {
    const requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
    let readCount = 0;

    const result = await syncSupabaseAuthConfig({
      root,
      accessToken: "test-only-token",
      apply: true,
      confirmedProjectRef: expectedProjectRef,
      fetchImpl: async (_input, init) => {
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        requests.push({ method, body });

        if (method === "PATCH") return Response.json({ ok: true });
        readCount += 1;
        if (readCount === 1) {
          return Response.json({
            site_url: "http://localhost:3000",
            uri_allow_list: "",
            disable_signup: true,
            external_email_enabled: false,
            mailer_autoconfirm: false,
          });
        }
        return Response.json({
          site_url: expectedSiteUrl,
          uri_allow_list: `${expectedSiteUrl}/`,
          disable_signup: false,
          external_email_enabled: true,
          mailer_autoconfirm: true,
        });
      },
    });

    expect(requests).toEqual([
      { method: "GET", body: undefined },
      {
        method: "PATCH",
        body: {
          site_url: expectedSiteUrl,
          uri_allow_list: `${expectedSiteUrl}/`,
          disable_signup: false,
          external_email_enabled: true,
          mailer_autoconfirm: true,
        },
      },
      { method: "GET", body: undefined },
    ]);
    expect(result).toMatchObject({ applied: true, verified: true });
  });

  test("CLI apply requires an explicit project-ref acknowledgement", () => {
    expect(parseAuthConfigArguments([])).toEqual({ apply: false });
    expect(() => parseAuthConfigArguments(["--apply"])).toThrow("--apply requires --project-ref");
    expect(parseAuthConfigArguments(["--apply", "--project-ref", expectedProjectRef])).toEqual({
      apply: true,
      projectRef: expectedProjectRef,
    });
    expect(() => parseAuthConfigArguments(["--force"])).toThrow("Unknown argument");
  });

  test("uses an environment token without invoking native credential storage", async () => {
    let credentialReadCount = 0;
    const token = `sbp_${"a".repeat(40)}`;

    await expect(
      resolveSupabaseAccessToken({
        environmentToken: token,
        platform: "linux",
        execFileImpl: async () => {
          credentialReadCount += 1;
          return { stdout: "", stderr: "" };
        },
      }),
    ).resolves.toBe(token);
    expect(credentialReadCount).toBe(0);
  });

  test("reads the logged-in default profile from macOS Keychain without a shell", async () => {
    const calls: Array<{
      executable: string;
      arguments_: string[];
      options: Record<string, unknown>;
    }> = [];
    const token = `sbp_oauth_${"b".repeat(40)}`;

    await expect(
      resolveSupabaseAccessToken({
        environmentToken: undefined,
        platform: "darwin",
        execFileImpl: async (executable, arguments_, options) => {
          calls.push({ executable, arguments_, options });
          return { stdout: `${token}\n`, stderr: "" };
        },
      }),
    ).resolves.toBe(token);
    expect(calls).toEqual([
      {
        executable: "/usr/bin/security",
        arguments_: ["find-generic-password", "-s", "Supabase CLI", "-a", "supabase", "-w"],
        options: {
          encoding: "utf8",
          maxBuffer: 4096,
          windowsHide: true,
        },
      },
    ]);
  });
});
