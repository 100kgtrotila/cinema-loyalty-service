-- AlterTable
ALTER TABLE "processed_events"
  ALTER COLUMN "event_id" TYPE VARCHAR(128) USING "event_id"::text;
