/*
  Warnings:

  - The primary key for the `loyalty_profiles` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `points` on the `loyalty_profiles` table. All the data in the column will be lost.
  - The `tier` column on the `loyalty_profiles` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `id` on the `loyalty_profiles` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `user_id` on the `loyalty_profiles` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('BRONZE', 'SILVER', 'GOLD');

-- AlterTable
ALTER TABLE "loyalty_profiles" DROP CONSTRAINT "loyalty_profiles_pkey",
DROP COLUMN "points",
ADD COLUMN     "balance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "balance_expires_at" TIMESTAMPTZ,
ADD COLUMN     "birthday_date" DATE,
ADD COLUMN     "last_activity_at" TIMESTAMPTZ,
ADD COLUMN     "lifetime_points" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tier_expires_at" TIMESTAMPTZ,
ADD COLUMN     "year_points" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "year_visits" INTEGER NOT NULL DEFAULT 0,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "user_id",
ADD COLUMN     "user_id" UUID NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ,
DROP COLUMN "tier",
ADD COLUMN     "tier" "Tier" NOT NULL DEFAULT 'BRONZE',
ADD CONSTRAINT "loyalty_profiles_pkey" PRIMARY KEY ("id");

-- DropEnum
DROP TYPE "LoyaltyTier";

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "points_transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "points" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "order_id" UUID,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "points_transactions_user_id_idx" ON "points_transactions"("user_id");

-- CreateIndex
CREATE INDEX "points_transactions_created_at_idx" ON "points_transactions"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_profiles_user_id_key" ON "loyalty_profiles"("user_id");

-- CreateIndex
CREATE INDEX "loyalty_profiles_user_id_idx" ON "loyalty_profiles"("user_id");

-- CreateIndex
CREATE INDEX "loyalty_profiles_tier_idx" ON "loyalty_profiles"("tier");
