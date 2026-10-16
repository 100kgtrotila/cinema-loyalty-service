-- Stop old GOLD Use/Rollback/reset writers before applying and upgrading.
CREATE TABLE "gold_upgrade_reservations" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "month" VARCHAR(7) NOT NULL,
  "order_id" UUID,
  "released_at" TIMESTAMPTZ,
  CONSTRAINT "gold_upgrade_reservations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gold_upgrade_reservations_user_id_order_id_key"
  ON "gold_upgrade_reservations"("user_id", "order_id");
CREATE UNIQUE INDEX "gold_upgrade_reservations_active_month_key"
  ON "gold_upgrade_reservations"("user_id", "month") WHERE "released_at" IS NULL;

-- Preserve occupancy, never invent an order owner or silently free legacy quota.
INSERT INTO "gold_upgrade_reservations"("id", "user_id", "month")
SELECT gen_random_uuid(), "user_id", "gold_upgrade_used_month"
FROM "loyalty_profiles" WHERE "gold_upgrade_used_month" IS NOT NULL;
