import { test, expect } from "./fixtures";
import { createTestAccount, signInTestAccount } from "./accounts";

test("the next online member takes host controls and late joins stay closed through a break", async ({
  browser,
}) => {
  const [host, successor, lateJoiner] = await Promise.all([
    createTestAccount(),
    createTestAccount(),
    createTestAccount(),
  ]);
  const hostContext = await browser.newContext();
  const successorContext = await browser.newContext();
  const lateContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  const successorPage = await successorContext.newPage();
  const latePage = await lateContext.newPage();

  try {
    await signInTestAccount(hostPage, host);
    await hostPage.locator("#rounds").fill("2");
    await hostPage.getByRole("button", { name: "Create room" }).click();
    await expect(hostPage.getByRole("heading", { name: "Room Invite" })).toBeVisible();
    const roomId = new URL(hostPage.url()).searchParams.get("id");
    if (!roomId) throw new Error("Room creation did not provide an invite ID.");

    await signInTestAccount(successorPage, successor);
    await successorPage.goto(`/join/${roomId}`);
    await successorPage.getByRole("button", { name: "Join room" }).click();
    await expect(successorPage.getByRole("heading", { name: "Room Invite" })).toBeVisible();

    await hostPage.getByRole("button", { name: "Leave room and go home" }).click();
    await expect(successorPage.getByRole("button", { name: "Start race" })).toBeVisible();
    await successorPage.getByRole("button", { name: "Start race" }).click();
    await expect(successorPage.getByRole("timer")).toBeVisible();

    await signInTestAccount(latePage, lateJoiner);
    await latePage.goto(`/join/${roomId}`);
    await latePage.getByRole("button", { name: "Join room" }).click();
    await expect(latePage.getByRole("alert")).toContainText(/already started/i);

    await successorPage.getByRole("button", { name: "Resign" }).click();
    await expect(successorPage.getByRole("heading", { name: "Round 1 complete" })).toBeVisible();
    await latePage.goto(`/join/${roomId}`);
    await latePage.getByRole("button", { name: "Join room" }).click();
    await expect(latePage.getByRole("alert")).toContainText(/already started/i);

    await successorPage.getByRole("button", { name: "Continue" }).click();
    await expect(successorPage.getByText("Round 2/2")).toBeVisible();
    await successorPage.getByRole("button", { name: "Resign" }).click();
    await expect(successorPage.getByRole("heading", { name: "Race complete" })).toBeVisible();
    await expect(successorPage.getByRole("table").getByText(successor.username)).toBeVisible();
  } finally {
    await Promise.all([hostContext.close(), successorContext.close(), lateContext.close()]);
  }
});

test("an empty room evaporates after all clients disconnect", async ({ browser, page }) => {
  test.setTimeout(100_000);
  const host = await createTestAccount();
  const visitor = await createTestAccount();
  const hostContext = await browser.newContext();
  const hostPage = await hostContext.newPage();

  await signInTestAccount(hostPage, host);
  await hostPage.getByRole("button", { name: "Create room" }).click();
  await expect(hostPage.getByRole("heading", { name: "Room Invite" })).toBeVisible();
  const roomId = new URL(hostPage.url()).searchParams.get("id");
  if (!roomId) throw new Error("Room creation did not provide an invite ID.");

  await hostContext.close();
  await page.waitForTimeout(32_000);
  await signInTestAccount(page, visitor);
  await page.goto(`/join/${roomId}`);
  await page.getByRole("button", { name: "Join room" }).click();
  await expect(page.getByRole("alert")).toContainText(/room not found/i);
});
