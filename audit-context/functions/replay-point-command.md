## `replayPointCommand` — src/loyalty/point-command-idempotency.ts L26–60

**Purpose:** Історичний replay/відмова за глобальним command key. Аналіз function_b, запис координатора.

**Inputs & Assumptions:** Caller transaction client + parsed normalized command. Callers lock profile перед helper (`loyalty.service.ts:134–137`, expiration `:262–265`); helper сам lock/transaction не відкриває.

**Outputs & Effects:** Лише SELECT; undefined відсутньому key, false/0 legacy/conflict, stored success exact match.

---

**Block-by-Block:**

```typescript
// L30–34
const existing = await tx.processedEvent.findUnique({
  where: { eventId: command.idempotencyKey },
});
if (!existing) return undefined;
```
L34–39: null operation — unverifiable marker, явна LEGACY_IDEMPOTENCY, без реконструкції result. L41–51: mismatch operation/user/order/amount → conflict. L53–59: null result throws; exact match повертає stored balance без profile read. Позиція перед business checks дозволяє повтор після зміни балансу/видалення профілю.

---

**Cross-Function Dependencies:** ProcessedEvent PK schema L45; additive CHECK migration L10–17 забезпечує typed-result completeness; claim helper L62–84 використовує replay після lost INSERT race.

**Open Questions:** Історичний результат спирається на retention/незмінність record. Immutable DB constraint у helper: `nothing found`; конкретні writers/cleanup слід відрізняти від зовнішнього direct SQL. Tests не запускалися.
