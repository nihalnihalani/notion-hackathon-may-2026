/**
 * Active-route selector shared between the sidebar and any future nav surface.
 *
 * Pulled into its own module (no React, no `next/navigation`, no lucide
 * imports) so it can be unit-tested in the node-only vitest env without
 * pulling client-only modules into the graph.
 *
 * The rule: an item is "active" if its `href` is the longest nav item that
 * matches the current pathname — exact match, or prefix-with-slash-boundary
 * if no more-specific entry is also a match. This is what stops
 * `/dashboard/new` from also highlighting `/dashboard`.
 */

export interface NavRouteLike {
  readonly href: string;
}

export function isActiveRoute(
  pathname: string | null | undefined,
  href: string,
  items: readonly NavRouteLike[],
): boolean {
  if (!pathname) return false;
  if (pathname === href) return true;
  const isPrefix = pathname.startsWith(`${href}/`);
  if (!isPrefix) return false;
  return !items.some(
    (other) =>
      other.href !== href &&
      other.href.length > href.length &&
      (pathname === other.href || pathname.startsWith(`${other.href}/`)),
  );
}
