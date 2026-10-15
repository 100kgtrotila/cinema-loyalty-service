## `refundPoints` — src/loyalty/loyalty-expiration.service.ts L242–309

**Purpose:** Зарахувати суму повернення з атомарним ledger та історичним result. Аналіз function_b, запис координатора.

**Inputs & Assumptions:** Чотири gRPC поля controller L68–75 за API-key guard. Parse helper L5–21 валідовує UUID/positive int32/key1..128. Original debit lookup, order ownership та refund budget у цьому шляху: `nothing found`.

**Outputs & Effects:** Лише balance та updatedAt, REFUND ledger, command metadata/result L277–297; expiry/lifetime/counters не оновлюються. Replay — історичний balance.

---

**Block-by-Block:**

```typescript
// L262–265
return await withTransactionRetry(this.prisma, async (trx) => {
  const profileLocked = await lockLoyaltyProfile(trx, command.userId);
  const replay = await replayPointCommand(trx, command);
  if (replay) return replay;
```
Невалідний input → false/0 до DB L248–260. Lock перед dedupe; replay можливий без current profile. Нова команда без профілю → false L267–275.

L277–279: current balance+amount, claim до effect. Claim conflict повертає raced replay. L281–295: profile/ledger на тому самому trx, rollback охоплює claim. L299–307: усі thrown errors після retry → INTERNAL_REFUND.

---

**Cross-Function Dependencies:** READ COMMITTED/max3 conflicts retry та lock без create (`profile-transaction.ts:9–78`); helpers replay/claim L26–84; processed PK/CHECK (`schema:44–53`, migration L10–17).

**Open Questions:** Original-debit relation — зовнішнє business узгодження, не встановлена гарантія. Characterization distinct keys без debit — integration test L331–337. Tests прочитані, без запуску.
