import { test, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Two-browser collaboration flow.
 *
 * This exercises the real product: two authenticated users in the same room,
 * board updates propagating, selected-ticket presence, and realtime comments.
 *
 * REQUIREMENTS to run meaningfully:
 *   - App running (Playwright starts `npm run dev` via webServer config).
 *   - Postgres up and seeded (`npm run db:seed`).
 *   - Liveblocks keys set in `.env` (LIVEBLOCKS_SECRET_KEY +
 *     NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY) for presence/comments assertions.
 *
 * Without Liveblocks keys the presence/comment steps are skipped automatically
 * (see `realtime` guard) and only the durable board-sharing path is asserted.
 * The manual two-browser demo is documented in the README.
 */

const realtime = Boolean(process.env.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY);

async function signIn(page: Page, email: string, name: string) {
  await page.goto("/");
  // Free-form dev sign-in form.
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/rooms");
}

async function openSeedRoom(page: Page): Promise<string> {
  await page.goto("/rooms");
  const firstRoom = page.getByRole("link", { name: /AgentGuard Development/i });
  await firstRoom.first().click();
  await page.waitForURL(/\/rooms\/.+/);
  return page.url();
}

test("two users share a room, board, presence and comments", async ({
  browser,
}) => {
  const contextA: BrowserContext = await browser.newContext();
  const contextB: BrowserContext = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  // 1-2. Sign in as two different users.
  await signIn(pageA, "prasanna@devroom.local", "Prasanna");
  await signIn(pageB, "priya@devroom.local", "Priya");

  // 3. Both open the same room.
  const roomUrl = await openSeedRoom(pageA);
  await pageB.goto(roomUrl);

  await expect(pageA.getByRole("heading", { name: "AgentGuard Development" })).toBeVisible();
  await expect(pageB.getByRole("heading", { name: "AgentGuard Development" })).toBeVisible();

  // 4. User A creates a ticket.
  const title = `E2E ticket ${Date.now()}`;
  await pageA.getByRole("button", { name: "+ New ticket" }).click();
  await pageA.getByLabel("Title").fill(title);
  await pageA.getByRole("button", { name: "Create ticket" }).click();
  await expect(pageA.getByText(title)).toBeVisible();

  if (!realtime) {
    test.info().annotations.push({
      type: "skip-reason",
      description:
        "Liveblocks keys not set — skipping realtime propagation, presence and comment assertions. Run the manual two-browser demo instead (see README).",
    });
    await contextA.close();
    await contextB.close();
    return;
  }

  // 5. User B sees the board update without a manual refresh.
  await expect(pageB.getByText(title)).toBeVisible({ timeout: 15_000 });

  // 6. User B selects the ticket.
  await pageB.getByRole("button", { name: `Open ticket: ${title}` }).click();

  // 7. User A sees User B as a viewer of that ticket.
  await expect(
    pageA.getByLabel(/viewing:.*Priya/i).first(),
  ).toBeVisible({ timeout: 15_000 });

  // 8. User B posts a comment.
  await pageA.getByRole("button", { name: `Open ticket: ${title}` }).click();
  const comment = `Hello from Priya ${Date.now()}`;
  const composer = pageB.locator(".lb-composer-editor").first();
  await composer.click();
  await composer.fill(comment);
  await pageB.keyboard.press("Enter");

  // 9. User A sees the comment in real time.
  await expect(pageA.getByText(comment)).toBeVisible({ timeout: 15_000 });

  await contextA.close();
  await contextB.close();
});
