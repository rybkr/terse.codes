import { test, expect } from "./fixtures";
import { createTestAccount, signInTestAccount } from "./accounts";

test("tabs in one browser share a valid account session", async ({ browser }) => {
  const account = await createTestAccount();
  const context = await browser.newContext();
  const firstTab = await context.newPage();
  const secondTab = await context.newPage();

  try {
    await signInTestAccount(firstTab, account);
    await secondTab.goto("/");
    await expect(secondTab.getByText(`Signed in as ${account.username}`)).toBeVisible();

    await firstTab.getByRole("button", { name: "Create room" }).click();
    await expect(firstTab.getByRole("heading", { name: "Room Invite" })).toBeVisible();
    await secondTab.reload();
    await expect(secondTab.getByText(`Signed in as ${account.username}`)).toBeVisible();
    await expect(secondTab.getByRole("link", { name: "Resume your active room" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a newer login for the same account replaces the prior browser session", async ({ browser }) => {
  const account = await createTestAccount();
  const oldContext = await browser.newContext();
  const newContext = await browser.newContext();
  const oldPage = await oldContext.newPage();
  const newPage = await newContext.newPage();

  try {
    await signInTestAccount(oldPage, account);
    await signInTestAccount(newPage, account);

    await expect(newPage.getByText(`Signed in as ${account.username}`)).toBeVisible();
    await oldPage.reload();
    await expect(oldPage).toHaveURL(/\/sign-in/);
    await expect(oldPage.locator(".cl-signIn-root")).toBeVisible();
  } finally {
    await Promise.all([oldContext.close(), newContext.close()]);
  }
});
