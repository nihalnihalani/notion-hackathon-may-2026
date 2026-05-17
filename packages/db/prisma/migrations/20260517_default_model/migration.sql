-- Add `defaultModel` to Workspace — the user-chosen primary model for paid sub-agents.
--
-- "auto" is the sentinel value meaning "let the router pick"; the API treats
-- it identically to null. Stored as TEXT (not an enum) because the set of
-- available models will grow over time and we don't want a migration for each.
ALTER TABLE "Workspace" ADD COLUMN "defaultModel" TEXT DEFAULT 'auto';
