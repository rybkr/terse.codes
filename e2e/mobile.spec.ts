import { test, expect } from "./fixtures";
import { createTestAccount, signInTestAccount } from "./accounts";

test("mobile layout stays within the viewport and editor shortcuts submit", async ({ browser }) => {
  const account = await createTestAccount();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  try {
    await signInTestAccount(page, account);
    await expectNoHorizontalOverflow(page);

    const createRoom = page.getByRole("button", { name: "Create room" });
    await createRoom.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Room Invite" })).toBeVisible();

    await page.getByRole("button", { name: "Start race" }).click();
    const editor = page.locator(".monaco-editor");
    await expect(editor).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await editor.click();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByText(/All tests passed|tests passed|Wrong answer|Error/).first()).toBeVisible({
      timeout: 30_000,
    });
    await expectNoHorizontalOverflow(page);
  } finally {
    await context.close();
  }
});

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits, "page should not scroll horizontally").toBe(true);
}
