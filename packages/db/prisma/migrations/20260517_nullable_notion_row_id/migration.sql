-- Make `Generation.notionRowId` nullable.
--
-- Dashboard-originated triggers don't have a Notion row at the time of
-- enqueue (the Shipper creates one downstream). The trigger API used to
-- pass an empty string; we now persist null and let the workflow backfill
-- the id when it creates the row.
ALTER TABLE "Generation" ALTER COLUMN "notionRowId" DROP NOT NULL;
