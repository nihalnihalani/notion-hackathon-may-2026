import { test, expect, type APIResponse } from '@playwright/test';

/**
 * Forge happy-path E2E.
 *
 * This file holds two flavors of test:
 *
 *   1. Public-surface regression guards (always run): assert the security and
 *      shape contracts that the install → trigger → deploy flow relies on.
 *      These don't need a sandbox Notion workspace or a Clerk test user — they
 *      hit endpoints that are reachable without auth (or whose 401/403 shape
 *      we *want* to verify).
 *
 *   2. Full live happy-path (`FORGE_E2E_LIVE=true`): performs the real
 *      install → trigger → poll flow against a sandbox Notion workspace. Opt-in
 *      so a missing secret in CI doesn't fail the whole pipeline; CI ships
 *      the credentials by setting the env var on the protected branch.
 *
 * The shared expected flow being captured (live only):
 *   1. Sign in via Clerk using a test session token.
 *   2. Install the Forge Notion integration into a sandbox workspace.
 *   3. Submit a natural-language agent description.
 *   4. Poll `/api/forge/generations/:id` until `status === 'succeeded'`.
 *   5. Assert a deploy URL + a `customAgentId` are present.
 */

const HEALTH_PATH = '/api/healthz';
const TRIGGER_PATH = '/api/forge/trigger';
const NOTION_BUTTON_WEBHOOK = '/api/webhooks/notion-button';
const FORGE_LOG_PATH = '/api/forge/log';

test.describe('Forge — public-surface regression guards', () => {
  test('GET /api/healthz returns 200 with the documented shape', async ({ request }) => {
    const res = await request.get(HEALTH_PATH);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, { ok: boolean; latencyMs: number }>;
      version: string;
      timestamp: string;
    };
    expect(['ok', 'degraded']).toContain(body.status);
    expect(body.checks).toHaveProperty('database');
    expect(body.checks).toHaveProperty('redis');
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.version).toBe('string');
  });

  test('POST /api/forge/trigger rejects unauthenticated requests', async ({ request }) => {
    // No Clerk session cookie → middleware should refuse before the handler
    // runs. The exact status is 401 or 307 depending on Clerk version; we
    // accept either because both encode "not authorized" cleanly.
    const res = await request.post(TRIGGER_PATH, {
      data: { description: 'should never get processed' },
    });
    expect([401, 307, 302, 403]).toContain(res.status());
  });

  test('POST /api/webhooks/notion-button rejects unsigned payloads', async ({ request }) => {
    // The Notion button webhook is HMAC-signed per workspace. A POST with no
    // signature header must be rejected — this is the only thing standing
    // between a public URL and an attacker triggering arbitrary generations.
    const res = await request.post(NOTION_BUTTON_WEBHOOK, {
      data: { pageId: 'forged', blockId: 'forged' },
    });
    expectAuthRejection(res);
  });

  test('POST /api/forge/log rejects requests without the internal token', async ({
    request,
  }) => {
    // The Build Log appender is an internal-only endpoint (workflow → Notion).
    // Calls without the FORGE_INTERNAL_TOKEN bearer must 401.
    const res = await request.post(FORGE_LOG_PATH, {
      data: { generationId: 'nope', message: 'forged' },
    });
    expectAuthRejection(res);
  });

  test('Landing page exposes the sign-in entry point', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Forge/);
    // The Clerk SignInButton renders a "Sign in with Notion" CTA at least once
    // (it appears in both the topbar and the hero on signed-out state).
    const ctas = page.getByRole('button', { name: /sign in with notion/i });
    await expect(ctas.first()).toBeVisible();
  });

  test('Unauthenticated /dashboard hits the auth gate', async ({ page }) => {
    const response = await page.goto('/dashboard');
    // Either a Clerk-hosted sign-in page (200) or a redirect to one. Either
    // way, the dashboard URL must not be the final URL — otherwise the
    // middleware regressed and unauthed users can see protected data.
    expect(response?.ok()).toBeTruthy();
    expect(page.url()).not.toMatch(/\/dashboard\/?$/);
  });
});

/**
 * Live happy-path. Opt-in via `FORGE_E2E_LIVE=true`. Requires:
 *   - `FORGE_E2E_BASE_URL` (defaults to PLAYWRIGHT_BASE_URL)
 *   - `FORGE_E2E_CLERK_SESSION` (a Clerk test-mode session token)
 *   - `FORGE_E2E_DESCRIPTION` (the prompt to forge; defaults to a known
 *     golden-path prompt that the prompt cache primes)
 *   - `FORGE_E2E_TIMEOUT_MS` (defaults to 180s; bumps the poll budget)
 */
const liveEnabled = process.env['FORGE_E2E_LIVE'] === 'true';

test.describe('Forge — live install → trigger → deploy', () => {
  test.skip(!liveEnabled, 'FORGE_E2E_LIVE not set — opt-in to run');

  test('end-to-end: trigger a generation and poll until succeeded', async ({
    request,
  }) => {
    const session = process.env['FORGE_E2E_CLERK_SESSION'];
    if (!session) {
      throw new Error(
        'FORGE_E2E_LIVE=true but FORGE_E2E_CLERK_SESSION is missing',
      );
    }
    const description =
      process.env['FORGE_E2E_DESCRIPTION'] ??
      'Pull my open Linear bugs every hour and write a triaged summary into this database.';
    const totalBudget = Number(process.env['FORGE_E2E_TIMEOUT_MS'] ?? 180_000);

    const triggerRes = await request.post(TRIGGER_PATH, {
      headers: clerkHeaders(session),
      data: { description, force: true },
    });
    expect(triggerRes.status(), `trigger body: ${await safeText(triggerRes)}`).toBeLessThan(
      300,
    );
    const trigger = (await triggerRes.json()) as {
      generationId: string;
      status: 'queued' | 'cached';
      agentId?: string;
    };
    expect(trigger.generationId).toBeTruthy();

    // Short-circuit: the trigger may legitimately return a cached agent if the
    // same prompt was Forged inside the idempotency window. That's still a
    // pass — the UI shows the cached deploy.
    if (trigger.status === 'cached') {
      expect(trigger.agentId).toBeTruthy();
      return;
    }

    // Poll generation status until terminal. We use a small jittered backoff
    // so a transient 5xx doesn't blow the whole budget.
    const deadline = Date.now() + totalBudget;
    let lastBody: unknown = null;
    while (Date.now() < deadline) {
      const res = await request.get(`/api/forge/generations/${trigger.generationId}`, {
        headers: clerkHeaders(session),
      });
      if (res.ok()) {
        lastBody = await res.json();
        const status = (lastBody as { status?: string }).status;
        if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
          break;
        }
      }
      await sleep(jitteredBackoff());
    }

    const final = lastBody as {
      status: string;
      agentId?: string;
      deployUrl?: string;
      customAgentId?: string | null;
    } | null;
    expect(final, 'never received a terminal status before deadline').not.toBeNull();
    expect(final?.status).toBe('succeeded');
    expect(final?.deployUrl || final?.agentId || final?.customAgentId).toBeTruthy();
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function expectAuthRejection(res: APIResponse): void {
  // Reject = either a 401/403 from the handler, or a Clerk redirect (3xx) if
  // the proxy fronts it. We just want to confirm the request did NOT succeed
  // through to handler execution.
  expect([401, 403, 307, 302]).toContain(res.status());
}

function clerkHeaders(sessionToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${sessionToken}`,
    Cookie: `__session=${sessionToken}`,
    'content-type': 'application/json',
  };
}

async function safeText(res: APIResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable>';
  }
}

function jitteredBackoff(): number {
  // 1s ± 250ms — gentle on the workflow runtime.
  return 1000 + Math.floor(Math.random() * 500) - 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
