## `OutboxPublisherService.publishPendingEvents` in src/loyalty/outbox-publisher.service.ts (L25-L57)

**Purpose:** Один cron tick відновлює прострочені claims і передає до 50 доступних outbox events у мережевий publisher; без цього входу PENDING records не переходять до доставки (L25-L44).

**Inputs & Assumptions:**
- Аргументів немає. Неявні входи: Prisma, EventEmitter2, ConfigService з constructor DI (L19-L23), локальний `publishing` (L17), PostgreSQL clock у callee (L66-L77, L89-L95).
- `app.outboxPublishConcurrency` — trusted startup configuration: integer 1..50 встановлює src/config/app.config.ts L30-L40; getOrThrow перевіряє наявність у L31-L33, але не повторює numeric validation.
- Schema migration має бути застосована: SQL використовує lease_token/lease_expires_at/next_attempt_at (L68-L76,L88-L95); потрібні колонки й індекси додає prisma/migrations/20261015220000_add_outbox_claim_lease/migration.sql L4-L12. Runtime migration gate у функції: nothing found.
- Старі publisher instances повинні бути зупинені: migration comments L1-L3 і README.md L384-L390 встановлюють operator procedure; програмне fencing старої версії: nothing found.

**Outputs & Effects:** Повертає Promise<void>; локально змінює publishing. Callees змінюють outbox state, роблять EventEmitter/RabbitMQ publication і пишуть logs (L30-L50; L62-L165). Окремі processEvent rejections поглинаються й логуються (L42-L51); помилки recoverExpiredClaims, config або claimEvents виходять caller-у, але finally звільняє локальний guard (L54-L56).

**Block-by-Block:**
```typescript
// L25-L30
@Cron(CRON_SCHEDULES.EVERY_5_SECONDS, { waitForCompletion: true })
async publishPendingEvents(): Promise<void> {
  if (this.publishing) return;
  this.publishing = true;
  try {
    await this.recoverExpiredClaims();
```
- **What:** Запобігає одночасному повторному tick тієї самої instance, потім робить recovery.
- **Why here:** Встановлення guard до першого await охоплює також direct calls; recovery відкриває retry-state до claim.
- **Assumes:** Cron registration встановлює LoyaltyModule ScheduleModule.forRoot (src/loyalty/loyalty.module.ts L31,L65); інші replicas не поділяють boolean, а координуються SQL claim (L91-L97).
- **Establishes:** Для тієї самої object instance другий виклик повертається без SQL, доки guard true (L27-L28).
- **Depended on by:** Наступні хвилі; integration specification test/integration/outbox-lease.integration-spec.ts L390-L424 явно перевіряє повторний call під час held wave.

```typescript
// L31-L41
const concurrency = this.configService.getOrThrow<number>('app.outboxPublishConcurrency');
for (let claimed = 0; claimed < BATCH_SIZE; ) {
  const events = await this.claimEvents(Math.min(concurrency, BATCH_SIZE - claimed));
  if (events.length === 0) break;
  claimed += events.length;
```
- **What:** Запитує тільки immediately runnable wave; tick claim budget 50 (L10).
- **Why here:** Попередня wave завершується перед наступним claim; усередині локального очікування немає заздалегідь захопленої великої пачки (L42-L44).
- **Assumes:** claimEvents дотримується limit: SQL SELECT LIMIT у L95, unique id table визначає outer UPDATE cardinality; atomic UPDATE/SKIP LOCKED запобігає спільному claim між replicas (L85-L97).
- **Establishes:** До 50 claims на tick і до configured concurrency одночасних processEvent wrappers (L34-L44). Це не межа для мережевих операцій, які пережили timeout: processEvent L111-L124 явно не скасовує underlying effect.
- **Depended on by:** Bounded runnable work; test L390-L424 перевіряє 53 records, peak=2, два ticks і no waiting leased rows.

```typescript
// L42-L56
const results = await Promise.allSettled(events.map((event) => this.processEvent(event)));
for (const result of results) {
  if (result.status === 'rejected') {
    const error: unknown = result.reason;
    this.logger.error(`Could not record outbox result; lease recovery will retry: ${error instanceof Error ? error.message : String(error)}`);
  }
}
// ...
finally { this.publishing = false; }
```
- **What:** Запускає одну wave, очікує всі wrappers, логує непоглинуті failures і гарантовано скидає local guard.
- **Why here:** Один DB write failure не відкидає очікування інших events і не припиняє весь tick (L42-L53).
- **Assumes:** processEvent представляє завершення актуальної спроби wrapper-а; його finally очищує timer, success/failure SQL може reject (L133-L164). Безмежно довгий DB query не обмежується timeout-ом цієї функції: nothing found у L25-L57.
- **Establishes:** Всі повернуті processEvent promises мають observed rejection; publishing скидається також після claim/config/recovery exception (L54-L56).
- **Depended on by:** Наступний cron/direct call.

**Cross-Function Dependencies:**
- `recoverExpiredClaims` (internal L59-L80): bounded 50 row recovery, PostgreSQL time, token-bearing expired PROCESSING → PENDING+backoff або FAILED за attempts>=max; exhausted PENDING → FAILED. Legacy PROCESSING без ownership не вибираються (L60-L76). Failure aborts tick, guard reset.
- `claimEvents` (internal L82-L99): atomic SQL claim тільки due PENDING attempts<max; attempts increment on claim, UUID token, PostgreSQL lease; no transaction held across emit (L85-L97).
- `processEvent` (internal L101-L166): emitAsync race timeout; missing listener rejected; success/failure DB writes require same token+PROCESSING+unexpired lease. Completion DB failure propagates без іншого failure update (L125-L165).
- `TierUpgradeListener.handle` (external-source-available src/loyalty/notifications/tier-upgrade.listener.ts L21-L50): suppressErrors:false, lastValueFrom(client.emit), stable outbox timestamp/messageId, rethrows broker errors. Function relies on listener promise as publication signal; consumer-side exactly-once is not established by this boundary.
- Callers: cron decorator L25; tests direct invoke. Provider wiring src/loyalty/loyalty.module.ts L65.
- Shared state: outbox rows changed by recovery/claim/process; local guard shared тільки within same instance (L17,L27-L28,L55).
- Invariant coupling: claim-level attempt count includes crash (L87); terminal/exponential backoff in both recovery and failure (L64-L70,L129-L138); stale success/failure fenced by token+lease (L140-L142,L161-L163).

**Open Questions:**
- Які production DB query/connection timeout bounds діють для recovery/claim/completion? PrismaService constructor передає лише connectionString (src/prisma/prisma.service.ts L9-L12); у функції нічого не задається.
- Чи operational rollout справді зупиняє всі old publisher instances? README.md L384-L390 описує вимогу; runtime evidence тут відсутнє.
- Чи всі persisted event types мають listener і consumer deduplication? `processEvent` явно відмовляє без listener (L125-L126), а ця функція не валідовує type (L37-L44).

Тести лише прочитані; виконання перевірок у цьому context-building pass не здійснювалося.
