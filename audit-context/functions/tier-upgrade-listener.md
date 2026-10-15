## `TierUpgradeListener.handle` in src/loyalty/notifications/tier-upgrade.listener.ts (L21-L52)

**Purpose:** Adapter від outbox emitter до RabbitMQ tier notification.

**Inputs & Assumptions:** `payload: TierUpgradeEvent`, `context: OutboxDeliveryContext` довірені persisted claim data; processEvent створює context з outbox id/created_at (outbox-publisher.service.ts L107-L114). Runtime payload validation у listener: nothing found. Injected ClientProxy налаштовує LoyaltyModule L44-L50 через getRabbitMqConfig.

**Outputs & Effects:** Promise<void>; logs і broker emit; error повторно кидається (L47-L50).

**Block-by-Block:**
```typescript
// L31-L43
await lastValueFrom(this.client.emit(RABBITMQ_EVENTS.TIER_UPGRADED,
  new RmqRecordBuilder({ userId: payload.userId, oldTier: payload.oldTier,
    newTier: payload.newTier, upgradedAt: context.occurredAt.toISOString() })
    .setOptions({ messageId: context.eventId, persistent: true }).build()));
```
- **What:** Зберігає JSON fields, persisted timestamp і stable ID між retries.
- **Why here:** Await перед success log дозволяє publisher побачити rejection.
- **Assumes:** Date context коректний; claim SQL повертає PostgreSQL timestamp. Receiver deduplicates messageId: nothing found у listener.
- **Establishes:** suppressErrors:false (L21) плюс rethrow (L50) передають errors до emitAsync caller.
- **Depended on by:** processEvent success/failure branches.

**Cross-Function Dependencies:** getRabbitMqConfig L9-L19 обирає RMQ, configured URL/queue, durable queue. Installed Nest ClientRMQ.dispatchEvent (node_modules/@nestjs/microservices/client/client-rmq.js L253-L272) завершує promise через sendToQueue callback; ChannelWrapper default confirm=true (node_modules/amqp-connection-manager/dist/cjs/ChannelWrapper.js L266). Це broker publication boundary, не завершення business handler одержувача. Publisher timeout не скасовує client emit (outbox-publisher.service.ts L111-L124).

**Open Questions:** Persistent receiver inbox/dedup і downstream effects; operational queue binding. Transport test читає повтор однакового body/messageId після completion DB failure (test/e2e/outbox.transport-spec.ts L90-L143), але тести тут не запускалися.
