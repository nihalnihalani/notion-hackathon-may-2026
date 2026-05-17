import { test, expect } from '@playwright/test';

/**
 * Smoke tests for the public landing page and auth-gated routes.
 *
 * These are intentionally narrow: they don't depend on a Notion sandbox or
 * Clerk test user (those land with the full happy-path spec). What they DO
 * verify is the static contract the dashboard makes with the proxy:
 *
 *   - `/`          renders the marketing page with the canonical title.
 *   - `/agents`    redirects an unauthenticated request to Clerk's sign-in.
 *
 * If either assertion ever breaks, we know either the proxy matcher or the
 * Clerk middleware changed shape — both of which should be caught before a
 * deploy.
 */

test('landing page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Forge/);
  // Hero heading uses "Describe an agent in English" — assert a stable
  // fragment so copy tweaks don't break the test, but a wholesale page
  // replacement does.
  await expect(
    page.getByRole('heading', { level: 1, name: /Ship it in 90 seconds/i })
  ).toBeVisible();
});

test('unauthed request to /agents redirects to sign-in', async ({
  page,
}) => {
  const response = await page.goto('/agents');
  // Clerk's middleware redirects (302/307) to `/sign-in` (or hosted equivalent).
  // We don't assert the exact target — Clerk supports both hosted and modal
  // flows — but we do assert that we did NOT land on the protected page.
  expect(response?.ok()).toBeTruthy(); // final response should be 200 (sign-in page)
  expect(page.url()).not.toContain('/agents');
});
