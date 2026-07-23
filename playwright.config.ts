import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_APP_PORT ?? 3411);
const localBaseURL = `http://127.0.0.1:${port}`;
const baseURL = process.env.E2E_APP_ORIGIN ?? localBaseURL;
const retainBrowserArtifacts = !process.env.CI;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE
    ? [["list"], ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE }]]
    : "list",
  use: {
    baseURL,
    trace: retainBrowserArtifacts ? "retain-on-failure" : "off",
    screenshot: retainBrowserArtifacts ? "only-on-failure" : "off",
    video: retainBrowserArtifacts ? "retain-on-failure" : "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  webServer: process.env.E2E_APP_ORIGIN
    ? undefined
    : {
        command: "bun run build && bun run start",
        url: localBaseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          NITRO_HOST: "127.0.0.1",
          NITRO_PORT: String(port),
        },
      },
});
