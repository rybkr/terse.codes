import { test, expect } from "./fixtures";
import { createTestAccount, signInTestAccount } from "./accounts";

test("isolated users join through invite, a kick blocks rejoin, and the race settles", async ({
  browser,
  page: hostPage,
}) => {
  const [host, guest, removed] = await Promise.all([
    createTestAccount(),
    createTestAccount(),
    createTestAccount(),
  ]);
  const guestContext = await browser.newContext();
  const removedContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  const removedPage = await removedContext.newPage();
  const errors: string[] = [];

  for (const playerPage of [hostPage, guestPage, removedPage]) {
    playerPage.on("pageerror", (error) => errors.push(error.message));
  }

  try {
    await signInTestAccount(hostPage, host);
    await hostPage.getByRole("button", { name: "Create room" }).click();
    await expect(hostPage.getByRole("heading", { name: "Room Invite" })).toBeVisible();
    const roomId = new URL(hostPage.url()).searchParams.get("id");
    expect(roomId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    if (!roomId) throw new Error("Room creation did not provide an invite ID.");

    await signInTestAccount(guestPage, guest);
    await guestPage.goto(`/join/${roomId}`);
    await guestPage.getByRole("button", { name: "Join room" }).click();
    await expect(guestPage.getByRole("heading", { name: "Room Invite" })).toBeVisible();

    await signInTestAccount(removedPage, removed);
    await removedPage.goto(`/join/${roomId}`);
    await removedPage.getByRole("button", { name: "Join room" }).click();
    await expect(removedPage.getByRole("heading", { name: "Room Invite" })).toBeVisible();
    await expect(hostPage.getByRole("list", { name: "Players" }).getByRole("listitem")).toHaveCount(3);

    await hostPage.getByRole("button", { name: `Remove ${removed.username} from room` }).click();
    await expect(hostPage.getByRole("list", { name: "Players" }).getByRole("listitem")).toHaveCount(2);

    await removedPage.goto(`/join/${roomId}`);
    await removedPage.getByRole("button", { name: "Join room" }).click();
    await expect(removedPage.getByRole("alert")).toContainText(/removed from this room/i);

    await hostPage.getByRole("button", { name: "Start race" }).click();
    await expect(hostPage.getByRole("timer")).toBeVisible();
    await expect(guestPage.getByRole("timer")).toBeVisible();
    await guestPage.getByRole("button", { name: "Resign" }).click();
    await expect(hostPage.getByRole("img", { name: "Resigned" })).toBeVisible();
    await hostPage.getByRole("button", { name: "Resign" }).click();

    await expect(hostPage.getByRole("heading", { name: "Race complete" })).toBeVisible();
    const standings = hostPage.getByRole("table");
    await expect(standings.getByText(host.username)).toBeVisible();
    await expect(standings.getByText(guest.username)).toBeVisible();
    await expect(standings).not.toContainText(host.email);
    await expect(standings).not.toContainText(guest.email);
    await hostPage.getByRole("link", { name: "Open player profile" }).click();
    await expect(hostPage.getByRole("heading", { name: host.username })).toBeVisible();
    await expect(hostPage.getByText("Career points")).toBeVisible();
    await expect(hostPage.locator("main")).not.toContainText(host.email);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([guestContext.close(), removedContext.close()]);
  }
});
