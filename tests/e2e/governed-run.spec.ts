import { expect, test, type Page } from "@playwright/test";

/**
 * The demo flow, end to end, through the real UI.
 *
 * Engineer creates a run → it executes under policy → it parks at the approval
 * gate → the engineer is refused self-approval → a reviewer approves → the run
 * delivers → the evidence report verifies.
 *
 * This is the acceptance test for the whole product. The integration suite
 * proves the services behave; this proves a person can actually drive them.
 *
 * Requires a running app with a seeded database:
 *   npm run db:seed && npm run build && npm start
 *   E2E_NO_SERVER=1 npx playwright test
 */

const ENGINEER = "arjun.rao@astra.dev";
const REVIEWER = "priya.shah@astra.dev";

/** Sign in through the dev credentials panel. */
async function signIn(page: Page, email: string) {
  await page.goto("/");

  // Already signed in as somebody: sign out first.
  const signOut = page.getByRole("button", { name: /sign out/i });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
    await page.waitForURL("/");
  }

  // The dev panel lists seeded teammates as one-click buttons; each button
  // carries its own email, which makes it an unambiguous target.
  await page.getByRole("button", { name: new RegExp(email, "i") }).click();
  await page.waitForURL("**/dashboard", { timeout: 20_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("governed agent run", () => {
  let runUrl = "";

  test("engineer creates a run and it parks at the approval gate", async ({
    page,
  }) => {
    await signIn(page, ENGINEER);

    await expect(
      page.getByRole("heading", { name: "Dashboard", level: 1 }),
    ).toBeVisible();

    await page.getByRole("link", { name: /new run/i }).first().click();
    await page.waitForURL("**/runs/new");

    // Preflight must state, before anything runs, that a PR needs approval.
    await expect(page.getByText(/requires approval/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/open a pull request/i)).toBeVisible();
    // And that secrets and production are off the table entirely.
    await expect(page.getByText("Denied")).toBeVisible();

    await page
      .getByLabel(/task title/i)
      .fill("Sessions expire an hour early (e2e)");
    await page
      .getByLabel(/detailed description/i)
      .fill("Fix the premature session expiry and add a regression test.");

    await page.getByRole("button", { name: /create and start run/i }).click();

    // Must exclude "/runs/new": a loose [a-z0-9]+ matches the form's own URL
    // and would capture it before the navigation even happens. Run ids are
    // cuids — "c" followed by 24 more characters.
    await page.waitForURL(/\/runs\/c[a-z0-9]{20,}$/, { timeout: 30_000 });
    runUrl = page.url();
    expect(runUrl).not.toContain("/runs/new");

    // The run should reach the gate on its own within the scripted pacing.
    await expect(page.getByText("Approval required").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Awaiting approval").first()).toBeVisible();

    // Live timeline actually streamed events in.
    await expect(page.getByText(/Policy check passed/).first()).toBeVisible();
  });

  test("the requester cannot approve their own run", async ({ page }) => {
    await signIn(page, ENGINEER);
    await page.goto(runUrl);

    await expect(
      page.getByText(/you started this run\. approval requires a second person/i),
    ).toBeVisible({ timeout: 15_000 });

    // No approve button is offered to them at all.
    await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
  });

  test("a reviewer approves, the run delivers, and evidence verifies", async ({
    page,
  }) => {
    await signIn(page, REVIEWER);
    await page.goto(runUrl);

    const approve = page.getByRole("button", { name: /^approve$/i });
    await expect(approve).toBeVisible({ timeout: 15_000 });

    await page
      .getByLabel(/comment/i)
      .fill("Unit fix is right and the regression test covers it.");
    await approve.click();

    // The run resumes and finishes.
    await expect(page.getByText("Completed").first()).toBeVisible({
      timeout: 60_000,
    });

    // A pull request was delivered, only after approval.
    await expect(page.getByText(/draft/i).first()).toBeVisible();

    // Evidence report.
    await page.getByRole("link", { name: /evidence report/i }).click();
    await page.waitForURL("**/evidence/**");

    await expect(
      page.getByText("Audit trail verified", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/verified across \d+ event/i)).toBeVisible();
    await expect(
      page.getByText("Evidence complete", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/append-only event trail/i)).toBeVisible();

    // The reviewer's decision is on the record.
    await expect(page.getByText(/priya shah/i).first()).toBeVisible();
    await expect(
      page.getByText(/unit fix is right and the regression test covers it/i),
    ).toBeVisible();
  });

  test("the evidence bundle downloads as JSON and verifies", async ({
    page,
  }) => {
    await signIn(page, REVIEWER);

    const runId = runUrl.split("/").pop()!;
    // page.request shares the browser context's cookies; the bare `request`
    // fixture has its own jar and would be unauthenticated here.
    const response = await page.request.get(
      `/api/runs/${runId}/evidence/download`,
    );
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-disposition"]).toContain("attachment");

    const bundle = await response.json();
    expect(bundle.integrity.valid).toBe(true);
    expect(bundle.completeness.complete).toBe(true);
    expect(bundle.approvals[0].status).toBe("APPROVED");
    expect(bundle.pullRequest).not.toBeNull();
    // Every event carries a hash, and the head fingerprints the run.
    expect(bundle.integrity.chainHead).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the policy simulator agrees with the engine", async ({ page }) => {
    await signIn(page, REVIEWER);
    await page.goto("/policies");

    await page.getByLabel(/^action$/i).selectOption("READ_FILE");
    await page.getByLabel(/file path/i).fill(".env.production");
    await page.getByRole("button", { name: /evaluate/i }).click();

    await expect(page.getByText("Denied").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(/agent access to secret material is prohibited/i),
    ).toBeVisible();
  });
});
