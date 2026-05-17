-- Add `stripeCustomerId` to Workspace.
--
-- Populated lazily by the billing layer the first time we create or look up
-- the Stripe customer for a workspace. Nullable so existing workspaces remain
-- valid; the /api/billing/usage handler treats a null id as "create on next
-- meter push".
ALTER TABLE "Workspace" ADD COLUMN "stripeCustomerId" TEXT;
