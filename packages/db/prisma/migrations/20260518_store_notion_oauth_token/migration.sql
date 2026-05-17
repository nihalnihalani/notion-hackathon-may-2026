-- Store the Notion OAuth access token for workspace-level operations.
--
-- The application stores an AES-GCM sealed value here, not the plaintext
-- access token. Nullable so existing workspaces remain valid; users can
-- re-run Notion OAuth to populate it.
ALTER TABLE "Workspace" ADD COLUMN "notionAccessTokenCiphertext" TEXT;
