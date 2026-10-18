import { defineConfig, devices } from "@playwright/test";

const stress = process.env.E2E_STRESS === "1";
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${stress ? 3011 : 3000}`;
const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const secretKey = process.env.CLERK_SECRET_KEY;

if (publishableKey && !publishableKey.startsWith("pk_test_")) {
  throw new Error("Playwright requires a Clerk development publishable key (pk_test_*).");
}

if (secretKey && !secretKey.startsWith("sk_test_")) {
  throw new Error("Playwright requires a Clerk development secret key (sk_test_*).");
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "/tmp/leetrace-playwright-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "/tmp/leetrace-playwright-report", open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: stress ? {
    command: "pnpm exec tsx --env-file-if-exists=.env --env-file-if-exists=.env.local e2e/stress-server.ts",
    url: `${baseURL}/health`,
    env: { APP_ORIGIN: baseURL, E2E_BASE_URL: baseURL },
    timeout: 30_000,
    reuseExistingServer: false,
  } : undefined,
  projects: [
    {
      name: "clerk-setup",
      testMatch: /clerk\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: stress ? /clerk\.setup\.ts/ : /clerk\.setup\.ts|stress\.spec\.ts/,
      testMatch: stress ? /stress\.spec\.ts/ : undefined,
      use: stress ? { viewport: { width: 1280, height: 720 } } : { ...devices["Desktop Chrome"] },
      dependencies: ["clerk-setup"],
    },
  ],
});
