-- UserApiKey — MCP-server keys, hashed at rest.
--
-- The plaintext key is shown ONCE at mint time via the dashboard
-- (POST /api/settings/api-keys). We store sha256(plaintext) in `hashedKey`
-- and surface `prefix` + `lastFour` so the UI can render "fk_live_…1234"
-- without re-fetching the secret.
--
-- Revocation: setting `revokedAt = NOW()` is sufficient — the validate
-- helper in `lib/api-keys.ts` rejects any row where `revokedAt IS NOT NULL`.
-- We deliberately do NOT delete rows so audit + analytics survive.
CREATE TABLE "UserApiKey" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "prefix"     TEXT NOT NULL,
    "lastFour"   TEXT NOT NULL,
    "hashedKey"  TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt"  TIMESTAMP(3),
    CONSTRAINT "UserApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserApiKey_hashedKey_key" ON "UserApiKey"("hashedKey");
CREATE INDEX "UserApiKey_userId_idx" ON "UserApiKey"("userId");

ALTER TABLE "UserApiKey"
    ADD CONSTRAINT "UserApiKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
