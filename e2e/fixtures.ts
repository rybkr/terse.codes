import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { test as base, expect, type Page } from "@playwright/test";

type Fixtures = {
  collectPageErrors: void;
  prepareClerk: void;
};

export const test = base.extend<Fixtures>({
  collectPageErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await use();
      if (errors.length > 0) {
        await testInfo.attach("browser-errors", {
          body: errors.join("\n"),
          contentType: "text/plain",
        });
      }
      expect(errors, "browser page errors").toEqual([]);
    },
    { auto: true },
  ],
  prepareClerk: [
    async ({ page }, use) => {
      await setupClerkTestingToken({ page });
      await use();
    },
    { auto: true },
  ],
});

export async function openPage(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await page.locator("body").waitFor({ state: "visible" });
}

export { expect };
