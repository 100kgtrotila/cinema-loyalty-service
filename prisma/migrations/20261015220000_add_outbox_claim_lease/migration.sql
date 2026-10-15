-- Additive only. Legacy PROCESSING rows have no owner and are deliberately
-- not replayed. Stop all old publishers before enabling the new publisher,
-- then reconcile explicitly selected legacy rows with the operator.
ALTER TABLE "outbox_events"
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ,
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "outbox_events_status_next_attempt_at_created_at_idx"
  ON "outbox_events"("status", "next_attempt_at", "created_at");
CREATE INDEX "outbox_events_status_lease_expires_at_idx"
  ON "outbox_events"("status", "lease_expires_at");
