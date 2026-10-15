## `registerAs(app)` callback in src/config/app.config.ts (L4-L52)

**Purpose:** Створює startup app configuration, включно з bounded outbox publication settings.

**Inputs & Assumptions:** Environment strings — deployment-controlled. Number conversion L5-L7,L17-L20,L30-L32; integer/range checks виконуються до return. ConfigModule завантажує factory (src/app.module.ts L13). Повторна dynamic reload environment після startup: nothing found.

**Outputs & Effects:** Повертає AppConfig; invalid outbox settings кидають Error до запуску publisher (L13-L15,L26-L28,L38-L40).

**Block-by-Block:**
```typescript
// L9-L11,L22-L24,L34-L36
!Number.isSafeInteger(outboxPublishTimeoutMs) || outboxPublishTimeoutMs <= 0 || outboxPublishTimeoutMs > 2147483647
!Number.isSafeInteger(outboxLeaseMs) || outboxLeaseMs <= outboxPublishTimeoutMs || outboxLeaseMs > 2147483647
!Number.isSafeInteger(outboxPublishConcurrency) || outboxPublishConcurrency < 1 || outboxPublishConcurrency > 50
```
- **What:** Timeout 1..2147483647, lease>timeout, concurrency 1..50.
- **Why here:** Callees getOrThrow перевіряють лише presence.
- **Assumes:** Deployment використовує factory; tests можуть інжектувати ConfigModule values напряму.
- **Establishes:** Default timeout10s, lease max(30s,timeout+5s), concurrency5 (L6,L19,L31).
- **Depended on by:** outbox-publisher.service.ts L31-L39,L83,L102-L104.

**Cross-Function Dependencies:** Timeout обмежує emitter wait; lease fencing використовує PG time. Factory не обмежує тривалість DB queries чи noncancelled sends (publisher L111-L124,L133-L164).

**Open Questions:** Deployment-specific latency bounds і clock behavior. Тести не запускалися.
