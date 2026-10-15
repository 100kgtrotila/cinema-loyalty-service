## `OutboxPublisherService.processEvent` in src/loyalty/outbox-publisher.service.ts (L101-L166)

**Purpose:** Перетворює один claim на bounded publication attempt і записує результат, тільки поки claim актуальний.

**Inputs & Assumptions:**
- `event: RawOutboxEvent` — trusted DB result claimEvents (L84-L98): token, incremented attempts, lease, payload і створений раніше timestamp.
- `app.outboxPublishTimeoutMs`: getOrThrow L102-L104; integer 1..2147483647 перевіряє src/config/app.config.ts L5-L15; lease>timeout перевіряє L21-L28.
- Кожний listener promise сигналізує publication result. TierUpgradeListener має suppressErrors:false і rethrow (src/loyalty/notifications/tier-upgrade.listener.ts L21,L47-L50), очікує lastValueFrom(client.emit) (L31-L43).
- Persistent downstream deduplication за stable messageId: listener передає ID (L40), але processEvent її не встановлює; у межах loyalty receiver implementation для зовнішнього side effect: nothing found.

**Outputs & Effects:** Promise<void>; EventEmitter publication, timeout timer, guarded outbox UPDATE і logs (L113-L165). Повідомлення зберігає persisted ID/time через context (L107-L110). Успішне завершення wrapper-а саме по собі не означає COMPLETED: failure та lost ownership paths також повертаються (L144-L149,L165).

**Block-by-Block:**
```typescript
// L113-L126
const results = await Promise.race([
  this.emitter.emitAsync(event.type, event.payload, context),
  new Promise<never>((_, reject) => { /* setTimeout reject */ }),
]);
if (results.length === 0)
  throw new Error(`No outbox listener registered for ${event.type}`);
```
- **What:** Очікує listeners або deadline; нуль listeners трактується failure.
- **Why here:** Publication результат перевіряється до completion write.
- **Assumes:** Listener success відповідає потрібному broker boundary; `TierUpgradeListener` очікує client emit, не business consumer effect (listener L31-L43).
- **Establishes:** Timeout обмежує очікування, не скасовує underlying emit (L111-L112); completion після deadline може існувати зовні, але локальний шлях вже catch.
- **Depended on by:** Retry model та consumer deduplication.

```sql
-- L135-L142
SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'PENDING' END,
    next_attempt_at = clock_timestamp() + ${delayMs} * interval '1 millisecond',
    error = ${message}, lease_token = NULL, lease_expires_at = NULL
WHERE id = ${event.id}::uuid AND status = 'PROCESSING'
  AND lease_token = ${event.lease_token}::uuid
  AND lease_expires_at > clock_timestamp()
```
- **What:** Listener error/timeout/missing listener → bounded retry або FAILED; delay 5–60 seconds (L129-L132).
- **Why here:** Тільки поточний непрострочений owner змінює retry state.
- **Assumes:** attempts був incremented при claim (L87).
- **Establishes:** Stale failure не скидає новий claim. updated=0 лише logLostOwnership; DB failure reject виходить наверх, finally очищує timer (L144-L152).
- **Depended on by:** Caller allSettled логування (L42-L50), recovery невдалого result write (L74-L76).

```sql
-- L157-L163
SET status = 'COMPLETED', published_at = clock_timestamp(),
    error = NULL, lease_token = NULL, lease_expires_at = NULL
WHERE id = ${event.id}::uuid AND status = 'PROCESSING'
  AND lease_token = ${event.lease_token}::uuid
  AND lease_expires_at > clock_timestamp()
```
- **What:** Пише completion поза publication catch (L154-L164).
- **Why here:** DB completion error не перетворює accepted broker effect у failure update.
- **Assumes:** Ownership-aware writers і PostgreSQL time узгоджені; old binaries runtime exclusion: nothing found.
- **Establishes:** Late old success не змінює новий claim; completion DB error залишає PROCESSING для expiry/retry, допускаючи повтор зовнішньої доставки (L154-L155).
- **Depended on by:** At-least-once contract README.md L372-L382.

**Cross-Function Dependencies:** claimEvents гарантує ownership; recovery забирає expired claim (L59-L99). Tier listener передає stable messageId і persisted time без зміни JSON shape (listener L34-L41). logLostOwnership лише logger.warn (L168-L171). Caller ловить кожний rejected wrapper через allSettled (L42-L50).

**Open Questions:** Реальний broker confirmation та routing boundary ClientProxy.emit; consumer persistent dedupe; DB statement timeout; deployment old-worker exclusion. Тести ownership/error/timeout/accepted-send DB failure прочитані у test/integration/outbox-lease.integration-spec.ts; не запускалися.
