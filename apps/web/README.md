# @forge/web

Next.js 16 application that hosts the Forge marketing landing page, the Clerk-authenticated dashboard (agents list, generations, settings), and every API route under `/api/forge/*` — including the Notion webhook handler that turns a button click into a Workflow DevKit run.

## File-convention notes

- Edge auth lives in `proxy.ts` (Next 16 renamed `middleware.ts` → `proxy.ts`).
  The exported function is still a Clerk adapter; matcher + public-route list
  are unchanged from the pre-16 contract.

## Public API surface

- Dashboard REST routes live under `apps/web/app/api/**`; the canonical route
  inventory is [docs/api.md](../../docs/api.md).
- Server-only DB imports go through `apps/web/lib/db.ts`.
- Auth and ownership gates are centralized in `apps/web/lib/auth.ts`.
- Notion token resolution and pacing live in `apps/web/lib/notion.ts`.
- API route tests live in `apps/web/__tests__/api`.
