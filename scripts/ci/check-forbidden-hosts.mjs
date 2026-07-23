import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const roots = ["bun.lock", "src", "public", "supabase/config.toml"];
const findings = [];
const urlPattern = /https?:\/\/[^\s"'`()<>]+/g;

async function filesUnder(path) {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (info.isFile()) return [absolute];
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => filesUnder(resolve(absolute, entry.name))),
  );
  return nested.flat();
}

for (const root of roots) {
  for (const file of await filesUnder(root)) {
    const source = await readFile(file, "utf8");
    const lines = source.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const lower = line.toLowerCase();
      const urls = line.match(urlPattern) ?? [];
      const hasForbiddenHost = urls.some((candidate) => {
        let url;
        try {
          url = new URL(candidate.replace(/[),.;]+$/, ""));
        } catch {
          return true;
        }
        const host = url.hostname.toLowerCase();
        return (
          host === "lovable.app" ||
          host.endsWith(".lovable.app") ||
          host === "lovable.dev" ||
          host.endsWith(".lovable.dev") ||
          host === "works.dev" ||
          host.endsWith(".works.dev") ||
          (host.endsWith(".pkg.dev") && url.pathname.toLowerCase().includes("lovable"))
        );
      });
      if (
        hasForbiddenHost ||
        lower.includes("lovable.app") ||
        lower.includes("works.dev") ||
        (lower.includes("pkg.dev") && lower.includes("lovable"))
      ) {
        findings.push(`${file.slice(process.cwd().length + 1)}:${index + 1}`);
      }
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Forbidden deployment host references found:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Forbidden deployment host gate passed.\n");
}
