-- Old event markers deliberately remain unverifiable. There is no reliable
-- relation from their key to a particular ledger row, so do not invent results.
ALTER TABLE "processed_events"
  ADD COLUMN "operation" VARCHAR(16),
  ADD COLUMN "user_id" UUID,
  ADD COLUMN "order_id" UUID,
  ADD COLUMN "amount" INTEGER,
  ADD COLUMN "balance_after" INTEGER;

ALTER TABLE "processed_events" ADD CONSTRAINT "processed_events_command_result_check"
  CHECK (
    ("operation" IS NULL AND "user_id" IS NULL AND "order_id" IS NULL
      AND "amount" IS NULL AND "balance_after" IS NULL)
    OR ("operation" IS NOT NULL AND "operation" IN ('DEDUCT', 'REFUND')
      AND "user_id" IS NOT NULL AND "order_id" IS NOT NULL
      AND "amount" IS NOT NULL AND "amount" > 0 AND "balance_after" IS NOT NULL)
  );
