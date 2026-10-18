import { clerk } from "@clerk/testing/playwright";
import { test, expect, openPage } from "./fixtures";
import { createInvalidUsernameAccount, createTestAccount } from "./accounts";

test("redirects signed-out room links through sign-in and preserves the invite", async ({ page }) => {
  await openPage(page, "/join/ABC123");

  await expect(page).toHaveURL(/\/sign-in\?/);
  const current = new URL(page.url());
  expect(current.searchParams.get("redirect_url")).toBe("/join/ABC123");
  await expect(page.locator(".cl-signIn-root")).toBeVisible();
  await expect(page.getByRole("link", { name: /sign up/i })).toBeVisible();
});

test("creates a scoped development account through Clerk signup", async ({ page }) => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const email = `leetrace_${suffix}+clerk_test@example.com`;
  const username = `t${suffix.slice(0, 9)}`;

  await openPage(page, "/sign-up");
  await expect(page.locator(".cl-signUp-root")).toBeVisible();

  await fillIfVisible(page, 'input[name="firstName"]', "LeetRace");
  await fillIfVisible(page, 'input[name="lastName"]', "E2E");
  await fillIfVisible(page, 'input[name="username"]', username);
  await page.locator('input[name="emailAddress"]').fill(email);
  await fillIfVisible(page, 'input[name="password"]', "TerseCodes-E2E-2026!");
  const phone = page.locator('input[name="phoneNumber"]');
  if (await phone.isVisible().catch(() => false)) await phone.fill("+15555550100");
  const legal = page.locator('input[name="legalAccepted"]');
  if (await legal.isVisible().catch(() => false)) await legal.check();

  const verificationSent = page.waitForResponse(
    (response) => response.url().includes("prepare_verification") && response.status() === 200,
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await verificationSent;
  const code = page.getByRole("textbox", { name: /verification code/i });
  await expect(code).toBeVisible();
  await code.pressSequentially("424242");

  await expect(page).toHaveURL((url) => !url.pathname.startsWith("/sign-up"), { timeout: 30_000 });
  await expect(page.getByRole("navigation", { name: "Account" })).toBeVisible({ timeout: 30_000 });
});

test("rejects an incorrect password in Clerk sign-in", async ({ page }) => {
  const account = await createTestAccount();
  await openPage(page, "/sign-in");

  await page.getByRole("textbox", { name: /email address or username/i }).fill(account.email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const password = page.locator('input[name="password"]');
  await expect(password).toBeVisible();
  await password.fill("Definitely-wrong-E2E-password!");
  await page.getByRole("button", { name: /continue|sign in/i }).click();

  await expect(page.locator(".cl-signIn-root")).toBeVisible();
  await expect(page.getByTestId("form-feedback-error")).toContainText(/incorrect|invalid|not match/i);
});

test("blocks accounts with an invalid app username", async ({ page }) => {
  const account = await createInvalidUsernameAccount();
  await openPage(page);
  await clerk.signIn({ page, emailAddress: account.email });

  await expect(page.getByRole("heading", { name: "Couldn’t connect your account" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(/username with 4.?12/i);
});

async function fillIfVisible(
  page: import("@playwright/test").Page,
  selector: string,
  value: string,
): Promise<void> {
  const field = page.locator(selector);
  if (await field.isVisible().catch(() => false)) await field.fill(value);
}
