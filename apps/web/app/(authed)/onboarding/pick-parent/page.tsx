/**
 * /onboarding/pick-parent — stub picker for the Forge install parent page.
 *
 * The Notion REST API requires a parent page for `POST /v1/pages`; without
 * one, `@forge/installer` throws `InstallerError(step: 'create-root-page')`
 * and the OAuth callback route bounces the user here.
 *
 * v1 surface: static stub explaining the requirement + a placeholder list of
 * candidate pages. The real Notion-page picker (search + tree view + submit
 * → re-call installer with the chosen id) is tracked separately.
 *
 * When the picker UI lands, the form will POST to
 * `/api/onboarding/complete-install` with `{ parentPageId }` which will
 * re-invoke `installForgePage` and redirect to `/agents` on success.
 */

import Link from 'next/link';

export default function PickParentPage(): React.ReactElement {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-12">
      <h1 className="text-3xl font-semibold">Choose where to install Forge</h1>
      <p className="text-muted-foreground">
        Forge needs a Notion page to install its setup into — the page becomes
        the home for your Forge Requests database, Build Log, and the
        &quot;Forge this Agent&quot; button. Pick any page you have edit access
        to; you can move it later.
      </p>

      <section className="rounded-lg border bg-muted/30 p-6">
        <h2 className="mb-3 text-lg font-medium">Recent pages</h2>
        <p className="text-sm text-muted-foreground">
          The Notion-page picker UI is coming soon. For now, paste a page URL
          or ID into the field below and submit — the installer will create
          the Forge surface under that page.
        </p>
        <p className="mt-4 text-xs italic text-muted-foreground">
          Placeholder: candidate-page list / picker tree not yet wired.
        </p>
      </section>

      <div className="flex items-center justify-between">
        <Link
          href="/sign-in"
          className="text-sm underline underline-offset-4 hover:no-underline"
        >
          Back to sign-in
        </Link>
        <button
          type="button"
          disabled
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground opacity-60"
        >
          Install (picker not yet wired)
        </button>
      </div>
    </div>
  );
}
