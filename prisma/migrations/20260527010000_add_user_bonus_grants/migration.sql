-- CreateTable
CREATE TABLE "user_bonus_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "grant_year" SMALLINT NOT NULL,
    "points" INTEGER NOT NULL,
    "points_transaction_id" UUID,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_bonus_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_bonus_grants_points_transaction_id_key" ON "user_bonus_grants"("points_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_bonus_grants_user_id_type_grant_year_key" ON "user_bonus_grants"("user_id", "type", "grant_year");

-- CreateIndex
CREATE INDEX "user_bonus_grants_user_id_idx" ON "user_bonus_grants"("user_id");
