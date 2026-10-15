-- Prisma migrate deploy executes this migration without an explicit transaction.
-- Keep CONCURRENTLY outside BEGIN/COMMIT; it permits concurrent table writes.
-- Partial index is maintained here because Prisma DSL does not represent it.
CREATE INDEX CONCURRENTLY "outbox_events_exhausted_pending_idx"
  ON "outbox_events" ("created_at", "id")
  WHERE "status" = 'PENDING'::"OutboxEventStatus" AND "attempts" >= "max_attempts";
