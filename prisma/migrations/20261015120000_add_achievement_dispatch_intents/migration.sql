CREATE TABLE "achievement_dispatch_intents" (
    "id" UUID NOT NULL,
    "event_id" VARCHAR(91) NOT NULL,
    "user_id" UUID NOT NULL,
    "action_type" VARCHAR(40) NOT NULL,
    "payload" JSONB NOT NULL,
    "delivered_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "achievement_dispatch_intents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "achievement_dispatch_intents_user_id_event_id_action_type_key"
  ON "achievement_dispatch_intents" ("user_id", "event_id", "action_type");
CREATE INDEX "achievement_dispatch_intents_delivered_at_next_attempt_at_idx"
  ON "achievement_dispatch_intents" ("delivered_at", "next_attempt_at");
