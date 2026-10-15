## `expirePoints` — src/loyalty/loyalty-expiration.service.ts L100–165

**Purpose:** Пачками списує позитивні прострочені баланси з точним EXPIRE ledger. Аналіз делеговано function_b; цей артефакт записав координатор із повернутого record.

**Inputs & Assumptions:** Довірений optional progress callback; caller — Bull job processor L25–30. UUID unique id/userId встановлює schema L17–19. Clock `now` фіксується application process один раз L103. Синхронізація clocks replicas: `nothing found`.

**Outputs & Effects:** balance=0 та EXPIRE(-current balance) одним transaction client L137–149; total/progress після commit L152–155. Callback exception поширюється, попередні commits не скасовуються.

---

**Block-by-Block:**

```typescript
// L110,L116,L121
...(lastSeenId ? { id: { lt: lastSeenId } } : {}),
orderBy: { id: 'desc' },
lastSeenId = batch[batch.length - 1]?.id;
```
Межа з останнього кандидата перед mutation не залежить від подальшого перебування рядка у filter. Фільтр balance>0/expiry<=now L111–112 та BATCH_SIZE500 збережено. Порожня batch завершує обхід L119.

L124–135: окрема транзакція, lock без створення профілю, reread, missing/nonpositive/null/future expiry → false. Важливий порядок: захищений актуальний стан встановлюється до списання та розрахунку ledger.

L137–150: update balance0, ledger фактичної суми, true. Помилка будь-якого write відкочує callback. L152–160: total рахує лише true commits, callback поза транзакцією, наступна strict boundary.

---

**Cross-Function Dependencies:** withTransactionRetry READ COMMITTED/max3/40001/40P01/P2034 (`profile-transaction.ts:9–58`); lockLoyaltyProfile працює лише на переданому tx, SELECT FOR UPDATE L63–78. Shared profile writers мають той самий lock protocol. ORM/PostgreSQL commit/rollback — external framework boundary.

**Open Questions:** Snapshot concurrent insert/filter changes: `nothing found`; це окремі batch reads. Production lock/statement timeout і очікування щодо кандидатів, що з'явилися за пройденою межею, не встановлені функцією. Читано batch tests L133–164 та existing concurrency tests L493–561; запуску не було.
