# @forge/web

Next.js 16 application that hosts the Forge marketing landing page, the Clerk-authenticated dashboard (agents list, generations, settings), and every API route under `/api/forge/*` — including the Notion webhook handler that turns a button click into a Workflow DevKit run.

## File-convention notes

- Edge auth lives in `proxy.ts` (Next 16 renamed `middleware.ts` → `proxy.ts`).
  The exported function is still a Clerk adapter; matcher + public-route list
  are unchanged from the pre-16 contract.

## Public API surface

- TBD
