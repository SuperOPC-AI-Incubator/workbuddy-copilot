import { defineConfig } from "@playwright/test";

const port = 3000;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "bun run build && bun run start",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(port),
    },
  },
});
