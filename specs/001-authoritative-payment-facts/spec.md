# Feature Specification: Authoritative loyalty payment facts

**Feature Branch**: не створено; feature directory незалежний від Git branch.
**Created**: 2026-10-23
**Status**: Proposed — pending explicit implementation approval.
**Input**: Stage 1 / PR 1 — Persist authoritative loyalty payment facts.

## Overview / Context

Backend є авторитетним producer оплати. Зараз час покупки формується заново при створенні повідомлення, session identity не передається, а відсутність email блокує loyalty staging. Потрібен стабільний confirmed fact, який переживає retry/outage без зміни поточної loyalty economy.

Master: [B.1, D.7, E, F Stage 1, H-1 та I](../../docs/loyalty-economy-architecture-spec.md). H-1…H-16 — approved requirements. Ця зміна реалізує лише paid-fact частину H-1; pre-payment snapshot/reservations залишаються для пізніших етапів.

## User Scenarios & Testing

### User Story 1 — Stable confirmed payment fact (Priority: P1)

Loyalty отримує збережений результат конкретної успішної оплати незалежно від моменту доставки.

**Independent Test**: підтвердити оплату, перечитати order і event; повторити confirmation/delivery та порівняти core facts.

**Acceptance Scenarios**:
1. Given confirmed success, when confirmation commits, then PaidAt, paid order, valid tickets та delivery records збережені разом.
2. Given committed confirmation, when repeated with the same payment identity, then PaidAt/money не змінюються, нова business operation не виникає.
3. Given failed local commit, then partial paid/ticket/outbox state не залишається; зовнішній charge може потребувати reconciliation.
4. Given unknown payment outcome, then confirmed paid fact не створюється до підтвердження success.

### User Story 2 — Delivery independent of email and outages (Priority: P1)

Відсутній email або недоступний broker не повинні втратити loyalty event підтвердженої покупки.

**Independent Test**: підтвердити оплату без email та з broker outage; перевірити durable delivery record і подальшу доставку початкових facts.

**Acceptance Scenarios**:
1. Given no email, then loyalty staging виконується; notification branch може бути пропущена.
2. Given broker outage, then delivery відновлюється без переобчислення payment time/money.
3. Given duplicate delivery, then чинний consumer створює лише один business effect.

### Edge Cases

- Інший transaction ID для вже Paid order — чинна відмова, не переписування facts.
- Commit response lost — перевірити persisted result; exception не доводить rollback.
- Session pricing змінено після оплати — payment money не реконструюється з pricing.
- Старий disposable Paid record без PaidAt — не вигадувати час із now/BookingDate; діагностувати missing fact при побудові нового envelope.
- Повтор після GOLD/points discount не застосовує discount удруге.

## Requirements

### Functional Requirements

- **FR-001**: Зберігати paidAt один раз із локальним confirmed success. Це час фіксації монолітом, не provider charge timestamp і не delivery time.
- **FR-002**: Використовувати persisted orderId/userId/sessionId; eventId залишається orderId.
- **FR-003**: Використовувати persisted TotalAmount/PaidAmount/PointsUsed, без реконструкції з pricing/request.
- **FR-004**: Order/tickets/paid facts та related outbox records атомарні. Unknown payment не є success.
- **FR-005**: Повтор confirmation того самого payment зберігає результат; conflicting confirmation зберігає чинну відмову.
- **FR-006**: Зберегти pattern TicketPurchased і queue:loyalty_ticket_purchased; додати paidAt/sessionId, purchasedAt залишити alias paidAt.
- **FR-007**: No-email/email delivery failure не блокує durable loyalty staging. DB/outbox failures не ковтаються.
- **FR-008**: Чинний loyalty consumer приймає additive fields без зміни reward, ACK/retry/dedupe та achievement intents.
- **FR-009**: Outbox retry передає збережені core facts. Повторне формування з confirmed order теж їх не змінює; transport headers не є business identity.
- **FR-010**: Зберегти checkout serialization, GOLD ownership, reconciliation та відсутність auto-retry charging. Guards не ламають законну pre-confirmation compensation.

### Key Entities

- Confirmed order payment: order/user/session identity, transaction ID, paidAt, money, points used.
- Delivery record: serialized copy для at-least-once доставки, не власник payment truth.
- Loyalty projections: profile, ledger, processed event та intents залишаються чинними consumer results.

## Success Criteria

- **SC-001**: Кожен тестований новий confirmed payment має однакові persisted/delivered facts; replay не пересуває час.
- **SC-002**: Fault-before-commit не залишає partial local paid/ticket/outbox state.
- **SC-003**: Unknown не породжує paid event; lost response не дає другого charge/effect.
- **SC-004**: No-email і broker recovery доставляють початковий fact; duplicates не дублюють reward/progress.

## Master Traceability and Exclusions

| Requirements | Relevant master references |
| --- | --- |
| FR-001/002/003/006/009 | B.1, H-1, I; I-14 та paidAt частина I-15 |
| FR-004/005/008 | F Stage 1, I; I-06/I-25/I-28 збережені на відповідній стороні |
| FR-010 | I-07/I-26/I-27/I-29 збережені, не нова реалізація цих механізмів |

Не заявляти повного виконання I-13/I-15: session-completion earning і pre-payment reservations тут не реалізуються.

Excluded: FEFO, debt, birthday reservations, нові rates, tier lifecycle, completion worker, refund policy redesign, proto/gRPC changes, новий outbox/framework, unrelated refactoring, legacy balance conversion.

## Assumptions / Quality Review

- Дані disposable; reset/cleanup не авторизований документом.
- Основна implementation одиниця — backend PR. Loyalty production changes не потрібні, якщо real compatibility test підтвердить поточний extensible envelope.
- Product ambiguities відсутні; technical choices та verification описані в plan.md. Requirements/acceptance cases перевірювані, без довільних performance promises.
- Артефакти підготовлено за запитом; тести не запускалися, implementation approval очікується.
