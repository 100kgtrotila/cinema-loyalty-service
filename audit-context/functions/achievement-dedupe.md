## `AchievementsProcessor.processAchievement` in src/achievements/processors/achievements.processor.ts (L91-L213)

**Purpose:** Застосовує одну achievement definition до події; зберігає dedupe/progress/unlock/reward разом. Зміна L124-L135 розпізнає RPC marker у спільному namespace.

**Inputs & Assumptions:** Event перед цим проходить ActionEventSchema у process L31-L40; achievement — active definition із DB L53-L61. Criteria safeParse L97-L105; invalid criteria log+return. Helpers довіряють numeric metadata; критерій SUM бере Number(raw) і Math.round (achievement-progress.helper.ts L16-L24), локальної перевірки finite в helper немає.

**Outputs & Effects:** Promise<void>; один retried transaction на definition. Profile, marker, progress/unlock і reward ledger змінюються разом (L117-L212); ordinary skip paths комітять зроблений до них marker.

**Block-by-Block:**
```typescript
// L115-L130
const uniqueProcessId = `${eventId}_${achievement.id}`;
await withTransactionRetry(this.prisma, async (tx) => {
  await lockLoyaltyProfile(tx, userId, true);
  const idempotency = await tx.processedEvent.createMany({data:{eventId:uniqueProcessId},skipDuplicates:true});
  if (idempotency.count === 0) {
    const existing = await tx.processedEvent.findUnique({where:{eventId:uniqueProcessId}});
    if (existing?.operation != null) throw new Error('Idempotency key is already used for a point command');
```
- **What:** Profile-first lock, persistent per-event/definition marker; generic duplicate skip, RPC collision error.
- **Why here:** Dedupe до progress/reward.
- **Assumes:** eventId глобально визначає однаковий user/payload. Marker key не містить userId; payload binding: nothing found (L115,L120).
- **Establishes:** RPC marker не вважається completed achievement.
- **Depended on by:** Retry не дублює вже committed definition effects.

Progress upsert і unlocked guard (L142-L188) завершуються без reward до target або за reward<=0. Positive reward збільшує лише balance/lifetime і пише ledger з фактичним balanceAfter (L191-L207). Conditional unlock isUnlocked:false додатково обмежує unlock effect (L171-L182).

**Cross-Function Dependencies:** calculateAchievementProgressIncrement повертає count=1 або rounded SUM; shouldProcess=false виходить до marker (L110-L113). Profile transaction helper забезпечує READ COMMITTED/retry max3 і row lock. Caller обробляє всі definitions, збирає failures і кидає aggregate error (L67-L87); Bull configuration attempts3, exponential delay1000, failed jobs retained (src/config/bullmq.config.ts L13-L20). Раніше completed definitions пропускаються при whole-job retry.

**Open Questions:** Producer uniqueness user/event і generic payload identity; operational recovery retained terminal Bull jobs; numeric metadata guarantees для всіх internal callers. Тести не запускалися.
