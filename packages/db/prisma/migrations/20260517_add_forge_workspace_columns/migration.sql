-- Add columns required by @forge/installer to record Notion-side IDs of the
-- installed Forge surface (Agents DB, Button block, Build Log container) and
-- the per-workspace HMAC secret used to verify inbound Notion webhooks.
--
-- All new columns are nullable so existing rows (workspaces that installed
-- before this migration) remain valid; the installer's reconcile step on
-- next sign-in fills them in.

ALTER TABLE "Workspace" ADD COLUMN "forgeAgentsDbId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "forgeButtonBlockId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "forgeBuildLogBlockId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "webhookSecret" TEXT;
