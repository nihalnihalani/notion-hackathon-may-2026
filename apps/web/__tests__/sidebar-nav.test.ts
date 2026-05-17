/**
 * Pure-function tests for the sidebar nav's active-route selector.
 *
 * The component itself depends on `next/navigation` + React, which aren't
 * available in the node test env — but the routing logic is the part with
 * non-obvious behavior (longer-prefix items beat shorter-prefix items so
 * `/dashboard/new` is highlighted instead of `/dashboard`).
 */
import { describe, expect, it } from 'vitest';

import { isActiveRoute } from '../components/nav/active-route';

const ITEMS = [
  { href: '/dashboard' },
  { href: '/dashboard/new' },
  { href: '/agents' },
  { href: '/generations' },
  { href: '/settings' },
] as const;

describe('isActiveRoute', () => {
  it('returns false when pathname is null or empty', () => {
    expect(isActiveRoute(null, '/dashboard', ITEMS)).toBe(false);
    expect(isActiveRoute(undefined, '/dashboard', ITEMS)).toBe(false);
    expect(isActiveRoute('', '/dashboard', ITEMS)).toBe(false);
  });

  it('treats an exact match as active', () => {
    expect(isActiveRoute('/dashboard', '/dashboard', ITEMS)).toBe(true);
    expect(isActiveRoute('/dashboard/new', '/dashboard/new', ITEMS)).toBe(true);
  });

  it('treats a strict prefix as active when no more-specific item exists', () => {
    expect(isActiveRoute('/agents/abc123', '/agents', ITEMS)).toBe(true);
    expect(
      isActiveRoute('/generations/gen_1/runs/1', '/generations', ITEMS),
    ).toBe(true);
  });

  it('does not highlight a shorter-prefix item when a longer one matches', () => {
    // /dashboard/new lives under /dashboard but only /dashboard/new wins
    expect(isActiveRoute('/dashboard/new', '/dashboard', ITEMS)).toBe(false);
    expect(isActiveRoute('/dashboard/new', '/dashboard/new', ITEMS)).toBe(true);
  });

  it('rejects look-alike prefixes (no slash boundary)', () => {
    // `/dashboardx` must not light up `/dashboard`
    expect(isActiveRoute('/dashboardx', '/dashboard', ITEMS)).toBe(false);
    expect(isActiveRoute('/agentsboard', '/agents', ITEMS)).toBe(false);
  });

  it('only one item is active at a time for any given pathname', () => {
    const path = '/dashboard/new';
    const actives = ITEMS.filter((i) => isActiveRoute(path, i.href, ITEMS));
    expect(actives).toHaveLength(1);
    expect(actives[0]!.href).toBe('/dashboard/new');
  });
});
