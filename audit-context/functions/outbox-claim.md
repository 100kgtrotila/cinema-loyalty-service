## `OutboxPublisherService.claimEvents` in src/loyalty/outbox-publisher.service.ts (L82-L99)

**Purpose:** Атомарно резервує доступну хвилю outbox events до мережевої доставки.

**Inputs & Assumptions:**
- `limit: number` — trusted internal input. Caller передає min(configured concurrency, remaining budget) (L37-L39); конфігурація перевіряє integer 1..50 (src/config/app.config.ts L30-L40). Локальної повторної validation немає.
- `app.outboxLeaseMs`: getOrThrow L83; integer, >publish timeout, <=2147483647 встановлює app.config.ts L17-L28.
- PostgreSQL schema й gen_random_uuid доступні: migration додає lease columns (20261015220000 L4-L7); database version provisioning поза цією функцією. Runtime migration check: nothing found.

**Outputs & Effects:** Promise<RawOutboxEvent[]> з RETURNING * (L97). Пише PROCESSING, attempts+1, новий token, PG-clock expiry та updated_at (L85-L90). Payload/created_at не змінюються.

**Block-by-Block:**
```sql
-- L92-L95
SELECT id FROM outbox_events
WHERE status = 'PENDING'::"OutboxEventStatus"
  AND attempts < max_attempts AND next_attempt_at <= clock_timestamp()
ORDER BY created_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
```
- **What:** Бере due PENDING з невичерпаним budget; locked rows пропускає.
- **Why here:** Selection і outer UPDATE одна statement (L84-L98).
- **Assumes:** id унікальний — schema.prisma L93 @id.
- **Establishes:** Claim не перевищує limit; replicas не утримують однаковий поточний claim.
- **Depended on by:** publishPendingEvents bounded waves (L37-L44).

```sql
-- L86-L89
SET status = 'PROCESSING'::"OutboxEventStatus",
    attempts = attempts + 1,
    lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + ${leaseMs} * interval '1 millisecond'
```
- **What:** Фіксує attempt до publication, включно з можливим наступним crash.
- **Why here:** Ownership існує до повернення rows.
- **Assumes:** PostgreSQL clock — спільне джерело часу; його operational стабільність: nothing found.
- **Establishes:** Returned rows мають новий ownership; порядок RETURNING не обіцяється SQL ORDER BY підзапиту (L97).
- **Depended on by:** processEvent token+expiry fencing (L140-L142,L161-L163), recovery (L74-L76).

**Cross-Function Dependencies:** Caller не тримає DB transaction під час processEvent (L37-L44); expired PROCESSING спочатку обробляє recovery (L30). Індекси schema.prisma L109-L111 присутні; EXPLAIN не виконувався. RawOutboxEvent type описує snake_case RETURNING columns (src/loyalty/interfaces/raw-outbox-event.interface.ts L3-L19).

**Open Questions:** Фактичні query plan/statement timeout; rollout припинення старих workers, які не fence completion (README.md L384-L390). Тести не запускалися.
