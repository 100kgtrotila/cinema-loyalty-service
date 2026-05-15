/*
  Warnings:

  - The `tier` column on the `loyalty_profiles` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "LoyaltyTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');

-- AlterTable
ALTER TABLE "loyalty_profiles" DROP COLUMN "tier",
ADD COLUMN     "tier" "LoyaltyTier" NOT NULL DEFAULT 'BRONZE';
