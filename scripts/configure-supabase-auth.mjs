#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const MANAGEMENT_API_ORIGIN = "https://api.supabase.com";
const PROJECT_REF_PATTERN = /^[a-z]{20}$/;
const ACCESS_TOKEN_PATTERN = /^sbp_(?:oauth_)?[a-f0-9]{40}$/;
const execFile = promisify(execFileCallback);
const REVIEWED_REMOTE_FIELDS = [
  "site_url",
  "uri_allow_list",
  "disable_signup",
  "external_email_enabled",
  "mailer_autoconfirm",
];

function assertPlainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unexpected or missing keys`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function assertHttpsUrl(value, label, options = {}) {
  if (typeof value !== "string" || value.length === 0 || value.includes(",")) {
    throw new Error(`${label} must be a non-empty URL without commas`);
  }

  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (!options.allowPath && (url.pathname !== "/" || url.search || url.hash))
  ) {
    throw new Error(`${label} must be a public HTTPS origin`);
  }
  return options.allowPath ? url.href : url.origin;
}

function parseProjectRefFromToml(toml) {
  const matches = [...toml.matchAll(/^\s*project_id\s*=\s*"([a-z]+)"\s*(?:#.*)?$/gm)];
  if (matches.length !== 1 || !PROJECT_REF_PATTERN.test(matches[0][1])) {
    throw new Error("supabase/config.toml must contain exactly one valid project_id");
  }
  return matches[0][1];
}

function validateDesiredConfiguration(candidate) {
  const config = assertPlainObject(candidate, "supabase/auth.production.json");
  assertExactKeys(
    config,
    ["projectRef", "siteUrl", "additionalRedirectUrls", "enableSignup", "email"],
    "supabase/auth.production.json",
  );

  if (typeof config.projectRef !== "string" || !PROJECT_REF_PATTERN.test(config.projectRef)) {
    throw new Error("projectRef must be a 20-letter Supabase project ref");
  }

  const siteUrl = assertHttpsUrl(config.siteUrl, "siteUrl");
  if (!Array.isArray(config.additionalRedirectUrls) || config.additionalRedirectUrls.length === 0) {
    throw new Error("additionalRedirectUrls must contain at least one URL");
  }
  const additionalRedirectUrls = config.additionalRedirectUrls.map((value, index) =>
    assertHttpsUrl(value, `additionalRedirectUrls[${index}]`, { allowPath: true }),
  );
  if (new Set(additionalRedirectUrls).size !== additionalRedirectUrls.length) {
    throw new Error("additionalRedirectUrls must not contain duplicates");
  }
  if (additionalRedirectUrls.some((value) => new URL(value).origin !== new URL(siteUrl).origin)) {
    throw new Error("production redirect URLs must use the tracked site origin");
  }

  const email = assertPlainObject(config.email, "email");
  assertExactKeys(email, ["enableSignup", "enableConfirmations"], "email");

  return {
    projectRef: config.projectRef,
    siteUrl,
    additionalRedirectUrls,
    enableSignup: assertBoolean(config.enableSignup, "enableSignup"),
    email: {
      enableSignup: assertBoolean(email.enableSignup, "email.enableSignup"),
      enableConfirmations: assertBoolean(email.enableConfirmations, "email.enableConfirmations"),
    },
  };
}

export async function loadTrackedAuthConfiguration(root) {
  const [toml, manifest] = await Promise.all([
    readFile(resolve(root, "supabase/config.toml"), "utf8"),
    readFile(resolve(root, "supabase/auth.production.json"), "utf8"),
  ]);
  const config = validateDesiredConfiguration(JSON.parse(manifest));
  const tomlProjectRef = parseProjectRefFromToml(toml);

  if (tomlProjectRef !== config.projectRef) {
    throw new Error("supabase/config.toml and auth.production.json project refs do not match");
  }
  return config;
}

function desiredRemoteState(desired) {
  return {
    site_url: desired.siteUrl,
    uri_allow_list: desired.additionalRedirectUrls.join(","),
    disable_signup: !desired.enableSignup,
    external_email_enabled: desired.email.enableSignup,
    mailer_autoconfirm: !desired.email.enableConfirmations,
  };
}

export function createManagementAuthPatch(desired, remote) {
  assertPlainObject(remote, "remote Auth configuration");
  const wanted = desiredRemoteState(desired);
  return Object.fromEntries(
    REVIEWED_REMOTE_FIELDS.filter((field) => remote[field] !== wanted[field]).map((field) => [
      field,
      wanted[field],
    ]),
  );
}

export function parseAuthConfigArguments(arguments_) {
  let apply = false;
  let projectRef;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--project-ref") {
      projectRef = arguments_[index + 1];
      if (!projectRef || projectRef.startsWith("--")) {
        throw new Error("--project-ref requires a value");
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (projectRef !== undefined && !PROJECT_REF_PATTERN.test(projectRef)) {
    throw new Error("--project-ref must be a 20-letter Supabase project ref");
  }
  if (apply && projectRef === undefined) {
    throw new Error("--apply requires --project-ref");
  }
  return { apply, ...(projectRef === undefined ? {} : { projectRef }) };
}

function validatedAccessToken(candidate) {
  const token = typeof candidate === "string" ? candidate.trim() : "";
  if (!ACCESS_TOKEN_PATTERN.test(token)) {
    throw new Error("Supabase access token is missing or invalid");
  }
  return token;
}

export async function resolveSupabaseAccessToken({
  environmentToken,
  platform,
  execFileImpl = execFile,
}) {
  if (environmentToken) return validatedAccessToken(environmentToken);
  if (platform !== "darwin") {
    throw new Error("SUPABASE_ACCESS_TOKEN is required outside macOS");
  }

  try {
    const { stdout } = await execFileImpl(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Supabase CLI", "-a", "supabase", "-w"],
      {
        encoding: "utf8",
        maxBuffer: 4096,
        windowsHide: true,
      },
    );
    return validatedAccessToken(stdout);
  } catch {
    throw new Error(
      "Supabase CLI credential is unavailable; approve Keychain access or set SUPABASE_ACCESS_TOKEN",
    );
  }
}

async function readRemoteAuthConfig(fetchImpl, endpoint, accessToken) {
  const response = await fetchImpl(endpoint, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Supabase Auth config read failed with HTTP ${response.status}`);
  }
  return assertPlainObject(await response.json(), "remote Auth configuration");
}

export async function syncSupabaseAuthConfig({
  root,
  accessToken,
  apply,
  confirmedProjectRef,
  fetchImpl = fetch,
}) {
  const desired = await loadTrackedAuthConfiguration(root);

  if ((apply || confirmedProjectRef !== undefined) && confirmedProjectRef !== desired.projectRef) {
    throw new Error("--project-ref does not match the tracked Supabase project");
  }
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("SUPABASE_ACCESS_TOKEN is required");
  }

  const endpoint = `${MANAGEMENT_API_ORIGIN}/v1/projects/${desired.projectRef}/config/auth`;
  const remote = await readRemoteAuthConfig(fetchImpl, endpoint, accessToken);
  const patch = createManagementAuthPatch(desired, remote);
  if (!apply || Object.keys(patch).length === 0) {
    return {
      applied: false,
      verified: Object.keys(patch).length === 0,
      projectRef: desired.projectRef,
      patch,
    };
  }

  const response = await fetchImpl(endpoint, {
    method: "PATCH",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(`Supabase Auth config update failed with HTTP ${response.status}`);
  }

  const verifiedRemote = await readRemoteAuthConfig(fetchImpl, endpoint, accessToken);
  if (Object.keys(createManagementAuthPatch(desired, verifiedRemote)).length !== 0) {
    throw new Error("Supabase Auth config verification failed after update");
  }

  return {
    applied: true,
    verified: true,
    projectRef: desired.projectRef,
    patch,
  };
}

async function main() {
  const arguments_ = parseAuthConfigArguments(process.argv.slice(2));
  const accessToken = await resolveSupabaseAccessToken({
    environmentToken: process.env.SUPABASE_ACCESS_TOKEN,
    platform: process.platform,
  });
  const result = await syncSupabaseAuthConfig({
    root: process.cwd(),
    accessToken,
    apply: arguments_.apply,
    confirmedProjectRef: arguments_.projectRef,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: arguments_.apply ? "apply" : "plan",
        projectRef: result.projectRef,
        changes: result.patch,
        applied: result.applied,
        verified: result.verified,
      },
      null,
      2,
    )}\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Supabase Auth config failed"}\n`,
    );
    process.exitCode = 1;
  });
}
