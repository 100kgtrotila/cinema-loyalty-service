## `notifyExpiringUsers` — src/loyalty/loyalty-expiration.service.ts L37–98

**Purpose:** Позначити кандидатів сповіщеними та ініціювати Rabbit notification. Аналіз function_b, запис координатора.

**Inputs & Assumptions:** Optional trusted progress callback; now/window application-clock L40–47; UUID PK schema L18. Confirmation delivery не встановлена timestamp marker.

**Outputs & Effects:** lastExpiryNotificationAt update, points_expiring emit із candidate user/balance/expiry L77–89. Rabbit outbox цей шлях не використовує.

---

**Block-by-Block:**

```typescript
// L55–70: strict id boundary + filters, take500,id desc
...(lastSeenId ? { id: { lt: lastSeenId } } : {}),
// L75: save boundary before marker changes
lastSeenId = batch[batch.length - 1]?.id;
```
Фільтри L56–61 обирають positive balance/upcoming expiry/notification age. L77–82: batch marker update за ids. L84–90: emit після marker, не одна DB/broker transaction. Повернутий Observable не очікується. L92–96: candidate count/progress/log, не broker confirmation count.

---

**Cross-Function Dependencies:** Installed Nest ClientProxy.emit створює hot dispatch через connectable.connect (`node_modules/@nestjs/microservices/client/client-proxy.js:57–67`); відсутність subscription сама не означає відсутності відправки. ClientRMQ callback boundary `client-rmq.js:253–273` caller не очікує. Ця поведінка — незмінений залежний контекст, diff змінює pagination.

**Open Questions:** Durable recovery marked-but-undelivered notification: `nothing found` у цьому шляху. Snapshot concurrent balance/expiry changes не надається. Batch test L194–212 прочитаний без запуску.
