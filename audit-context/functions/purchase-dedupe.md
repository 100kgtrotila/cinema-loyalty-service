## `LoyaltyService.processTicketPurchase` in src/loyalty/loyalty.service.ts (L263-L408)

**Purpose:** Зберігає purchase rewards/visit, dedupe marker, tier outbox і achievement intents атомарно. Остання зміна розрізняє generic event marker та RPC command marker (L271-L276).

**Inputs & Assumptions:** `TicketPurchasedDto` — untrusted transport payload, class-validator boundary у TicketPurchasedConsumer.handle; service internal calls не повторюють validation. eventId є global processed_events key (schema.prisma ProcessedEvent). Generic marker доводить саме цей purchase payload: nothing found; legacy/generic має лише eventId.

**Outputs & Effects:** Promise<void>; profile, optional ledger/tier outbox, processed marker і intents у одному retried DB callback (L265-L398). Error логується й rethrow (L399-L406).

**Block-by-Block:**
```typescript
// L266-L276
await lockLoyaltyProfile(trx, msg.userId, true);
const alreadyProcessed = await trx.processedEvent.findUnique({where:{eventId:msg.eventId}});
if (alreadyProcessed) {
  if (alreadyProcessed.operation !== null) throw new Error(ERROR_MESSAGES.IDEMPOTENCY_CONFLICT);
  return;
}
```
- **What:** Profile-first lock; generic duplicate повертається, RPC-key collision виходить error.
- **Why here:** Dedupe до reward/progress mutations.
- **Assumes:** Усі profile writers беруть той самий lock; helper створює profile через ON CONFLICT і SELECT FOR UPDATE (src/prisma/profile-transaction.ts L60-L74).
- **Establishes:** RPC marker не перетворюється на silently skipped purchase; transaction rollback охоплює навіть profile creation.
- **Depended on by:** Consumer ack тільки після success.

```typescript
// L286-L293,L374-L397
const pointsEarned = pointsUsed > 0 ? 0 : Math.floor(actualAmountToReward * multiplier);
// profile + ledger + processed marker + optional tier outbox
await this.achievementsService.saveDispatchIntents(trx, [/* purchase, optional VIP */]);
```
- **What:** Рахує reward на protected profile; intent persistence без Redis.
- **Why here:** Всі effects комітяться з marker.
- **Assumes:** resolvePointsUsedForOrder бере explicit pointsUsed або latest negative BURN_DISCOUNT того user/order (L778-L797); generic payload identity додатково не встановлюється.
- **Establishes:** Purchase не потребує Redis усередині transaction; intents validated і createMany(skipDuplicates) тим самим tx (achievements.service.ts L27-L46).
- **Depended on by:** Наступний intent publisher.

**Cross-Function Dependencies:** Calculator resolveMultiplier/tier/type/addYears лише локальні обчислення (loyalty-calculator.service.ts L15-L65); retry helper READ COMMITTED, максимум3 SQL conflict attempts (profile-transaction.ts L9-L25). Consumer validation failure nack(no requeue); service exception nack(requeue=true), без окремої класифікації conflict (ticket-purchased.consumer.ts L29-L46).

**Open Questions:** Operational handling постійного namespace collision при consumer requeue; payload binding generic event keys; producer agreement щодо eventId/orderId. Тести не запускалися.
