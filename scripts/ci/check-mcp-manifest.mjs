// Fail when the committed MCP manifest no longer matches src/lib/mcp/index.ts.
//
// `.lovable/mcp/manifest.json` is a snapshot the Lovable platform reads to register the
// MCP server, and only the platform's own commit pipeline regenerates it. This repository
// deploys itself to Tencent Cloud instead, so nothing here refreshes the snapshot: it
// drifted for ten days once, still advertising five removed tools and a foreign project
// ref, without any check going red.
//
// The expected project ref comes from supabase/config.toml so the manifest issuer cannot
// disagree with the tracked project, and so CI needs no extra environment wiring.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestRelativePath = ".lovable/mcp/manifest.json";
const manifestPath = path.join(root, manifestRelativePath);
const configPath = path.join(root, "supabase/config.toml");

export function readTrackedProjectRef(configText) {
  const match = configText.match(/^project_id\s*=\s*"([a-z0-9][a-z0-9-]{2,62})"\s*$/m);
  if (!match) {
    throw new Error("supabase/config.toml does not declare a readable project_id");
  }
  return match[1];
}

function runOrThrow(label, command, args, extraEnv) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`${label} failed with exit code ${result.status}\n${detail}`);
  }
}

function main() {
  const projectRef = readTrackedProjectRef(readFileSync(configPath, "utf8"));
  const committed = readFileSync(manifestPath, "utf8");

  try {
    // The extract CLI writes the manifest in place, so the entry is the single source of
    // truth for the tool catalog. Its output is not Prettier-formatted, and `bun run check`
    // enforces formatting on the committed file, so normalize before comparing.
    runOrThrow(
      "lovable-mcp-extract-manifest",
      path.join(root, "node_modules/.bin/lovable-mcp-extract-manifest"),
      [],
      { VITE_SUPABASE_PROJECT_ID: projectRef },
    );
    runOrThrow("prettier", path.join(root, "node_modules/.bin/prettier"), [
      "--write",
      manifestRelativePath,
    ]);

    const regenerated = readFileSync(manifestPath, "utf8");
    if (regenerated !== committed) {
      process.exitCode = 1;
      console.error(
        [
          `${manifestRelativePath} is stale.`,
          "",
          "The committed snapshot no longer matches src/lib/mcp/index.ts. Regenerate it:",
          "",
          `  VITE_SUPABASE_PROJECT_ID=${projectRef} \\`,
          "    ./node_modules/.bin/lovable-mcp-extract-manifest",
          `  ./node_modules/.bin/prettier --write ${manifestRelativePath}`,
          "",
          "Then commit the result.",
        ].join("\n"),
      );
      return;
    }

    console.log(`${manifestRelativePath} matches the MCP entry (project ref ${projectRef}).`);
  } finally {
    // Always restore the committed bytes so a failure here cannot make a later step, or a
    // developer's working tree, look dirty for an unrelated reason.
    writeFileSync(manifestPath, committed);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
