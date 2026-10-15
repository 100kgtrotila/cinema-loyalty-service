## `OutboxPublisherService.recoverExpiredClaims` in src/loyalty/outbox-publisher.service.ts (L59-L80)

**Purpose:** Повертає прострочені claims у retry-state або terminal FAILED, перш ніж cron tick почне claims (caller L30). Старі PROCESSING без ownership залишає для operator reconciliation (L60-L61,L74-L76).

**Inputs & Assumptions:**
- Аргументів немає. Trusted dependency: PrismaService (constructor L20), PostgreSQL schema, server clock.
- `attempts` — кількість claims, не completions: встановлюється claimEvents L87; `max_attempts` — per-row budget (schema.prisma L99-L100 defaults 0/5, SmallInt).
- Числові attempts/max_attempts відповідають operational policy. SQL тип SmallInt забезпечує цілі значення; CHECK для attempts>=0/max_attempts>0 у schema/migration: nothing found. Нормальний producer використовує defaults, claim збільшує attempts (L87).
- Всі active publishers використовують ownership-aware writes: поточний processEvent L140-L142,L161-L163 перевіряє token+lease; для older binaries enforcement: nothing found. README.md L384-L390 і migration comments L1-L3 задають stop-old procedure.
- Міграція 20261015220000 застосована: додає nullable lease columns і next_attempt_at (migration L4-L7); runtime gate тут: nothing found.

**Outputs & Effects:** Promise<void>. Один atomic SQL UPDATE змінює status,next_attempt_at,lease_token,lease_expires_at,error,updated_at (L63-L71). Не змінює attempts, payload, created_at, published_at (SET L64-L71). Не повертає count і не логує кількість recovered rows (L62-L79). SQL error reject виходить caller-у, після чого caller finally скидає local publishing guard (L54-L56).

**Block-by-Block:**
```sql
-- L72-L77
WHERE id IN (
  SELECT id FROM outbox_events
  WHERE (status = 'PROCESSING'::"OutboxEventStatus"
         AND lease_token IS NOT NULL AND lease_expires_at <= clock_timestamp())
     OR (status = 'PENDING'::"OutboxEventStatus" AND attempts >= max_attempts)
  ORDER BY created_at, id LIMIT 50 FOR UPDATE SKIP LOCKED
)
```
- **What:** Вибирає до 50 oldest eligible rows за created_at,id, не очікує row locks, які вже утримує інший claimant/recovery worker.
- **Why here:** Row selection і mutation — одна SQL statement (L62-L79), без мережевої операції чи зовнішнього callback між ними.
- **Assumes:** UUID id унікальний: schema.prisma L93 визначає @id; тоді outer UPDATE не множить selected cardinality. PostgreSQL визначає row locks і clock_timestamp.
- **Establishes:** Active lease не eligible, token-null legacy PROCESSING не eligible; lease expiry equality достатня. PROCESSING із token але NULL lease також не проходить comparison. PENDING exhausted eligible незалежно від next_attempt_at.
- **Depended on by:** claimEvents L93-L95 бачить тільки PENDING attempts<max та due; тому exhausted rows у FAILED не доставляються.

```sql
-- L64-L71
SET status = CASE WHEN attempts >= max_attempts
      THEN 'FAILED'::"OutboxEventStatus" ELSE 'PENDING'::"OutboxEventStatus" END,
    next_attempt_at = clock_timestamp() +
      LEAST(60000, 5000 * power(2, LEAST(GREATEST(attempts - 1, 0), 4))) * interval '1 millisecond',
    lease_token = NULL, lease_expires_at = NULL,
    error = CASE WHEN attempts >= max_attempts THEN 'Outbox attempts exhausted (including expired claims)'
      ELSE 'Outbox claim lease expired; retry scheduled' END,
    updated_at = clock_timestamp()
```
- **What:** Exhausted → FAILED; otherwise → PENDING. Знімає ownership і встановлює backoff 5,10,20,40,60 seconds для claims 1..5, надалі 60; attempts<=1 також 5 seconds (L67).
- **Why here:** Crash уже витратив attempt під час claim (L87). Recovery не збільшує його вдруге; новий claim можливий після next_attempt_at (L94).
- **Assumes:** PostgreSQL time є спільним джерелом для claims, recovery і fencing (L66-L77,L89-L95,L142,L163). Wall-clock монотонність не перевіряється: nothing found.
- **Establishes:** Навіть crash останньої спроби має terminal path; stale worker не має старого актуального token після recovery (L68), а completion/failure потребують його (L141,L162).
- **Depended on by:** Наступні cron ticks і processEvent stale-result guards.

**Cross-Function Dependencies:**
- Caller publishPendingEvents L30 викликає recovery до читання concurrency/claim. Recovery одна пачка на tick, а publish budget окремо до 50 claims (L34-L41); немає loop recovery до повного drain.
- claimEvents L82-L99 пише token,lease,attempts; processEvent L133-L164 знімає ownership при normal success/failure. Recovery використовує той самий retry delay policy, але обчислює SQL-ом (L67 проти L129-L132).
- PrismaService (src/prisma/prisma.service.ts L8-L12) передає connectionString PostgreSQL adapter; raw UPDATE не обгорнутий application transaction із broker calls (L62-L79).
- Indexes: schema.prisma L109-L111 містить (status,createdAt), (status,nextAttemptAt,createdAt), (status,leaseExpiresAt); additive migration L9-L12 додає останні два. Predicate має OR, ORDER BY created_at,id і LIMIT (L74-L77). EXPLAIN/live cardinality в цьому проході не досліджені; індексна наявність не встановлює фактичного query plan.
- Tests read only: test/integration/outbox-lease.integration-spec.ts L165-L185 real process kill/restart; L325-L347 final-attempt crash; L426-L442 legacy exclusion; L304-L323 tests delay cap for processEvent failure path. Виконання не проводилося.

**Open Questions:**
- Чи operator rollout забезпечує відсутність old completion writers (README.md L384-L390)? Runtime coordination із старими binaries відсутня.
- Який query plan recovery за фактичної production кількості expired/terminal rows? EXPLAIN evidence не зібрано.
- Чи operational observability використовує error/status для виявлення FAILED і legacy PROCESSING? Recovery не емітує counter/log (L62-L79).
- Які bounds DB statement duration і зміни PostgreSQL wall-clock забезпечує deployment? Функція їх не задає (L62-L79).
