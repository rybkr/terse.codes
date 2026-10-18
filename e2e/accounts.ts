import { createClerkClient } from "@clerk/backend";
import { clerk } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

export type TestAccount = {
  email: string;
  username: string;
  password: string;
  userId: string;
};

export async function createTestAccount(): Promise<TestAccount> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return createClerkTestAccount(suffix, `p${suffix.slice(0, 9)}`);
}

export async function createInvalidUsernameAccount(): Promise<TestAccount> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return createClerkTestAccount(suffix, `bad-${suffix.slice(0, 4)}`);
}

async function createClerkTestAccount(suffix: string, username: string): Promise<TestAccount> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey?.startsWith("sk_test_")) {
    throw new Error("Multi-user tests require a Clerk development secret key (sk_test_*).");
  }

  const email = `leetrace_${suffix}+clerk_test@example.com`;
  const password = `TerseCodes-E2E-${suffix}!`;
  const backend = createClerkClient({ secretKey });
  const user = await backend.users.createUser({
    emailAddress: [email],
    ...(username ? { username } : {}),
    firstName: "LeetRace",
    lastName: "E2E",
    password,
  });

  return { email, username, password, userId: user.id };
}

export async function signInTestAccount(page: Page, account: TestAccount): Promise<void> {
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: account.email });
  await page.getByRole("navigation", { name: "Account" }).waitFor({ state: "visible" });
  await page.getByText(`Signed in as ${account.username}`).waitFor({ state: "visible" });
  const browserUserId = await page.evaluate(() => {
    const browserWindow = window as Window & {
      Clerk?: { user?: { id?: string | null } | null };
    };
    return browserWindow.Clerk?.user?.id ?? null;
  });
  if (browserUserId !== account.userId) {
    throw new Error("The browser signed into a different account than the account provisioned for this test.");
  }
}
