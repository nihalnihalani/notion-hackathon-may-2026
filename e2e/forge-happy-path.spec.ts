import { test, expect } from '@playwright/test';

/**
 * Forge happy-path E2E (STUB).
 *
 * This spec is intentionally skipped until the Notion sandbox workspace,
 * Clerk test user, and `ntn deploy --dry-run` flag are all wired up in CI.
 * Once they are, replace `test.skip` with `test` and flesh out each step.
 *
 * Expected flow being captured here:
 *   1. User signs in via Clerk (test-mode session token).
 *   2. User installs the Forge Notion integration into a sandbox workspace.
 *   3. User submits a natural-language agent description ("Email me when X").
 *   4. Forge's 4-agent pipeline runs (Schema Smith → Tool Coder → Inspector
 *      → Shipper) and posts a "deployed" message back into the same Notion page.
 *   5. The generated Custom Agent appears in the workspace agent registry.
 */
test.skip('install → trigger → deploy', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Forge/);
  // TODO: complete the flow once the sandbox harness lands.
});
