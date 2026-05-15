-- CreateTable
CREATE TABLE "loyalty_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL DEFAULT 'Bronze',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_profiles_user_id_key" ON "loyalty_profiles"("user_id");

-- CreateIndex
CREATE INDEX "loyalty_profiles_user_id_idx" ON "loyalty_profiles"("user_id");
