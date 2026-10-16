-- Empty registry: do not infer eligibility or compensation from legacy ledger.
-- Reconcile legacy orders before inserting their debit/refund references.
CREATE TABLE "checkout_debits" (
  "debit_id" UUID NOT NULL,
  "refund_id" UUID,
  CONSTRAINT "checkout_debits_pkey" PRIMARY KEY ("debit_id"),
  CONSTRAINT "checkout_debits_distinct_ledger_check"
    CHECK ("refund_id" IS NULL OR "refund_id" <> "debit_id"),
  CONSTRAINT "checkout_debits_debit_id_fkey" FOREIGN KEY ("debit_id")
    REFERENCES "points_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "checkout_debits_refund_id_fkey" FOREIGN KEY ("refund_id")
    REFERENCES "points_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "checkout_debits_refund_id_key" ON "checkout_debits"("refund_id");
