# Контекст останніх шести комітів

Область: `HEAD~6..HEAD`, база `5e2abf49b606d6e1530805dcf2a83f66165467df`, HEAD `5cb4875db67400c8f9f85bb23d667dfa9a139215`, гілка `refactor/bun-workflow-and-loyalty-reliability`. На початку робоче дерево чисте. Вибрано саме останні шість комітів за запитом; це не автоматичний фільтр довільного шестигодинного вікна.

| Коміт | Час commit (+03:00) | Область |
| --- | --- | --- |
| `5604c05` | 2026-10-15 22:59:11 | Строга межа обходу maintenance batches; PostgreSQL regression suite |
| `da95fa0` | 2026-10-15 22:59:19 | AGENTS, локальні skills, reliability/deployment guidance |
| `48c5be9` | 2026-10-15 22:59:24 | Локальний Codebase Memory helper та ignore |
| `db41cf8` | 2026-10-15 22:59:38 | Видалення коментарів buf.yaml |
| `b85e207` | 2026-10-16 00:24:58 | Rabbit outbox lease, fencing, retries, PostgreSQL/transport тести |
| `5cb4875` | 2026-10-16 00:25:11 | Зв'язування deduct/refund key із request/result; PostgreSQL/gRPC тести |

Це побудова контексту за `audit-context-building`: без оцінки дефектів, severity, рекомендацій виправлення або запуску тестів. Висновки про поведінку ґрунтуються на читанні цього HEAD. Створено лише артефакти `audit-context/`, відповідно до прямо викликаного skill; source, schema, tests і моноліт не змінювалися.

## Індекс функцій і покриття

Кожну функцію нижче аналізував окремий function task дочірнього агента; повторно використано лише встановлений контекст залежностей. Trivial logging/constructors/типи описані як залежності, не штучно розділені.

| Покриття diff | Артефакти |
| --- | --- |
| Чотири змінені maintenance loops | [expirePoints](functions/expiry.md), [resetAnnualStats](functions/annual-reset.md), [goldReset](functions/gold-reset.md), [notifyExpiringUsers](functions/notify-expiring.md) |
| RPC mutation paths | [deductPoints](functions/deduct-points.md), [refundPoints](functions/refund-points.md) |
| Три нові command helpers | [parse](functions/parse-point-command.md), [replay](functions/replay-point-command.md), [claim](functions/claim-point-command.md) |
| Змінені generic dedupe branches | [processTicketPurchase](functions/purchase-dedupe.md), [processAchievement](functions/achievement-dedupe.md) |
| Outbox scheduler/ownership/delivery | [publishPendingEvents](functions/outbox-publish-pending.md), [recoverExpiredClaims](functions/outbox-recover-expired.md), [claimEvents](functions/outbox-claim.md), [processEvent](functions/outbox-process-event.md) |
| Outbox adapter/config | [TierUpgradeListener.handle](functions/tier-upgrade-listener.md), [app config factory](functions/outbox-config.md) |
| Developer/test entrypoints | [memory wrapper](functions/codebase-memory-entrypoint.md), [worker fixture main](functions/outbox-worker-fixture.md), [transport setup](functions/transport-runner-setup.md) |
| Schema/migrations/generated | Зіставлення полів/CHECK/індексів нижче; generated wrappers без окремого business policy |
| Tests/assertion callbacks | Read-only inventory нижче; тестові callbacks/harness utilities не дублюються як production functions |
| Nonruntime files | Guidance/skills/docs, ignore та proto comment cleanup класифіковано нижче |

Незмінені transaction helpers, calculator/progress helpers, queue config, controller/guard та consumer прочитані як залежності; повний повторний аудит їхніх feature modules виключено. `logLostOwnership` — лише warn (`outbox-publisher.service.ts:168–172`), без persisted mutation; constructor DI та interfaces не мають окремого business effect.

## Точки входу та збережений стан

- gRPC: `LoyaltyController` має `@UseGuards(GrpcApiKeyGuard)` (`src/loyalty/loyalty.controller.ts:18–20`); deduct/refund передають чотири поля сервісам (`:48–55`, `:68–75`). Guard перевіряє `x-api-key` проти configured key (`src/guards/grpc-api-key.guard.ts:10–28`). Це authentication сервісу; окремого зв'язування userId з identity у цих двох handlers немає.
- Rabbit `TicketPurchasedConsumer.handle` валідує DTO та викликає purchase; validation failure відхиляє без requeue, exception від service повертає з requeue (`src/loyalty/consumers/ticket-purchased.consumer.ts:34–54`). Purchase coupling з RPC проходить через глобальний `processed_events.event_id`, не через спільний виклик.
- BullMQ `LoyaltyQueueProcessor.process` делегує expiry/notification/reset jobs; `job.updateProgress` callbacks виконуються після профільних commit (`src/loyalty/processors/loyalty-queue.processor.ts:25–49`).
- `OutboxPublisherService.publishPendingEvents` запускається Cron кожні п'ять секунд (`src/loyalty/outbox-publisher.service.ts:25–26`); локальний guard та SQL claim мають різні області дії.
- BullMQ `AchievementsProcessor.process` валідує job, обирає matching achievements і збирає помилки по кожній achievement (`src/achievements/processors/achievements.processor.ts:25–87`). Зміна в цьому diff стосується розпізнавання command marker у generic dedupe (`:124–135`).
- Персистентні таблиці: `LoyaltyProfile` (`prisma/schema.prisma:17–42`), `ProcessedEvent` (`:44–54`), `PointsTransaction` (`:56–69`), `OutboxEvent` (`:92–114`). Achievement intents наявні раніше цього діапазону (`:126–141`); вони контекст purchase, а не нова модель цього diff.

## Зв'язки викликів та інваріанти

```text
gRPC guard → controller → deduct/refund
  → parsePointCommand
  → withTransactionRetry → profile lock → replayPointCommand
  → business checks → claimPointCommand → profile + ledger → commit

Rabbit DTO → purchase → profile lock → generic dedupe
  → profile + ledger + processed event + tier outbox + achievement intents → commit

Bull maintenance job → batch(id desc, id < lastSeenId)
  → expiry/annual: окремий profile transaction
  → gold/notification: batch update

Cron publisher → recoverExpiredClaims → concurrency-sized claim wave
  → EventEmitter2 → TierUpgradeListener → RabbitMQ ClientProxy
  → token + unexpired lease conditional result update
```

`withTransactionRetry` задає READ COMMITTED та максимум три спроби для розпізнаних transaction conflicts; затримки знаходяться поза callback (`src/prisma/profile-transaction.ts:9–24`, `:27–58`). `lockLoyaltyProfile` працює на переданому tx, за потреби вставляє профіль через skipDuplicates та бере `FOR UPDATE` (`:63–78`). Коментар порядку profile → dedupe/progress/ledger/outbox — `:6–8`. SQL uniqueness `user_id` — schema `:19`; ключ processed event — schema `:45`.

Профіль, ledger і successful command result одного deduct/refund commit-яться через один transaction callback; business refusals до claim не резервують key (`loyalty.service.ts:134–188`, `loyalty-expiration.service.ts:262–297`). Exact replay повертає історичний `balanceAfter`, а не поточний balance (`point-command-idempotency.ts:26–59`). Глобальний INSERT із skipDuplicates серіалізує спільний ключ і для різних профілів (`:62–83`).

Outbox UPDATE claim використовує PostgreSQL clock, `SKIP LOCKED`, increments attempts на захопленні та новий UUID token (`outbox-publisher.service.ts:82–98`). Network effect знаходиться між SQL statements, без утримання DB transaction (`:101–165`). Completion/failure потребують token, PROCESSING і lease у майбутньому (`:136–143`, `:157–163`). Таймаут обмежує очікування (`:112–127`), а не скасовує публікацію; це прямо зазначено в коментарі `:111–112`.

## Schema, міграції та generated client

- Additive lease migration додає nullable token/expiry та due-time default; індекси `(status,next_attempt_at,created_at)` і `(status,lease_expires_at)` (`prisma/migrations/20261015220000_add_outbox_claim_lease/migration.sql:4–12`). Claim сортує `created_at,id`; фактичні production плани виконання не досліджувалися.
- Command migration додає п'ять nullable metadata/result columns та CHECK: усі null або DEDUCT/REFUND із усіма required fields та позитивним amount (`prisma/migrations/20261016010000_bind_point_command_results/migration.sql:3–17`). CHECK присутній у SQL migration, а не у Prisma DSL. Legacy markers не backfill-яться (`:1–2`).
- Generated client відповідає іменам нових полів: `src/generated/prisma/models/OutboxEvent.ts:253–255`, `models/ProcessedEvent.ts` та embedded schema/runtime model `internal/class.ts:23–35`. Generated delegate methods не аналізувалися по одному: вони механічне представлення schema, не окрема business policy. Codegen не запускався.

## Припущення для наступного етапу

| Припущення / межа | Що його встановлює |
| --- | --- |
| Міграції застосовані до активації нових workers | SQL наявний; runtime deployment gate: **nothing found** у прочитаному шляху |
| Старі outbox publishers припинені перед активацією token ownership | Операторська вимога README:384–389; примусова міжверсійна перевірка: **nothing found** |
| Усі RPC instances розуміють нові request/result metadata | Операторська вимога README:243–247; runtime version fence: **nothing found** |
| Споживач зовнішньої tier події дедуплікує повторну доставку | Стабільний AMQP messageId і occurredAt формує listener:34–40; persistent consumer dedupe в цьому репозиторії для зовнішнього recipient: **nothing found** |
| Refund має первісний debit та не перевищує його бюджет | `refundPoints` читає profile/command key, не первісний ledger:262–294; встановлення цього правила: **nothing found**; characterization test явно зберігає чинну поведінку (`test/integration/point-command-idempotency.integration-spec.ts:331–337`) |
| Generic event marker встановлює той самий user/payload для кожного повтору | Purchase marker зберігає тільки eventId (`loyalty.service.ts:332–334`); achievement marker — eventId_achievementId (`achievements.processor.ts:115–122`); payload binding тут: **nothing found** |
| Permanent key collision має обмежений Rabbit requeue | Purchase кидає conflict (`loyalty.service.ts:271–273`), consumer catch requeue=true (`ticket-purchased.consumer.ts:50–53`); bounded handling у цьому шляху: **nothing found** |
| Історичний command result не видаляється/змінюється | У production src знайдені INSERT writers, не ORM update/delete ProcessedEvent; DB-level immutability щодо зовнішнього SQL: **nothing found** |
| Batch traversal — snapshot довільних конкурентних вставок/змін filter | **nothing found**; read batches відокремлені, boundary — last candidate; per-profile expiry повторно перевіряє актуальний balance/expiry:124–135 |
| Application clocks для expiry синхронізовані між replicas | Використовується `new Date()` на старті job (`loyalty-expiration.service.ts:103`); зовнішня синхронізація: **nothing found** |

Ці записи описують межі доведення; вони не є findings чи оцінками ризику.

## Докази у тестах: лише читання

- `test/integration/profile-batches.integration-spec.ts:133–182`: 500/501/1001 expiry та annual; excluded profiles, exact ledger, unchanged fields, повтор expiry. `:185–212`: gold/notification по 501.
- `test/integration/profile-concurrency.integration-spec.ts:493–561`: наявний контрольований overlap expiry з purchase/deduct; цей suite існував до шести вибраних комітів, прочитаний як залежна гарантія.
- `test/integration/outbox-lease.integration-spec.ts:165–185`: окремий Node worker kill/restart; `:187–266` claim/active lease/stale success/failure; `:268–347` failure/timeout/backoff/final crash; `:349–441` completion DB failure, 53 events/concurrency2, legacy exclusion.
- `test/integration/point-command-idempotency.integration-spec.ts:102–131`: overlap підтверджується PG lock wait; `:139–284` replay, mismatch, casing, missing profile, concurrency, rollback/legacy; `:288–404` compensation replay, unfunded retry, generic collisions, refund characterization, invalid requests.
- `test/e2e/outbox.transport-spec.ts:90–149`: реальний RabbitMQ, повтор після acceptance + DB completion failure, stable body/messageId.
- `test/e2e/point-command.transport-spec.ts:130–143`, `:166–239`: test-only interceptor утримує відповідь після service completion; клієнт cancel/reconnect, точний replay та conflict через справжній gRPC.

Нових висновків «тести пройшли» у цьому аудиті немає. Попередні локальні результати не перевикористовуються як перевірка поточного запуску. Перевірки performance/load, rollout та production infrastructure не проводилися.

## Допоміжні зміни й виключення

- `scripts/codebase-memory.ps1:1–51`: локальний CLI wrapper, cache `.tmp/codebase-memory`, memory budget256MB/workers2, full default, auto_index/auto_watch при `index`, exit-code guard та environment restoration. Це developer tooling; сам binary і його фактичний budget implementation не досліджувалися.
- `test/fixtures/outbox-publisher-worker.cjs:14–53`: окремий процес справжнього publisher, disposable DB guard, IPC publishing/done та hold-mode для kill scenario. Test environment, не production entrypoint.
- `test/run-transports.mjs:100–115`: нова окрема DB для outbound/RPC suite в disposable container. Наявні config guards перевіряють loopback random ports/no volumes (`:55–74`), cleanup обмежений project (`:141–147`). Test helper functions `run/capture/endpoint` не змінювалися.
- AGENTS, skills/resources, skills-lock та docs — engineering guidance; не executable service paths. Їхні checklist твердження не вважаються гарантіями runtime. `src/proto/buf.yaml` змінює лише коментарі/whitespace; wire `.proto` не змінено. `.gitignore` додає machine-local config ignore.
- Не виконувалися repository-wide audit, моноліт audit, business rule redesign, API contract redesign, proof-of-concept або виправлення коду.

## Питання, що залишаються відкритими

1. Якими production settings обмежені query/connection/lock waits поза publish timeout?
2. Який механізм rollout доводить відсутність старих publishers та RPC replicas?
3. Де зовнішній recipient встановлює persistent messageId dedupe та reconciliation ambiguous sends?
4. Яка погоджена coordinator policy для unknown deduct outcome та refund budget? Цей service зберігає локальний result; це не доказ checkout recovery.
5. Які вимоги до конкурентних профілів, що стають кандидатами після проходження їх id, та до synchronization application clocks?

Під час звіряння уточнено старі line references lock helper до актуальних L63–78; артефакти використовують поточний файл. Різних висновків між повернутими function records не зафіксовано; непідтверджені зовнішні гарантії залишені питаннями. Notification adapter перевірено за встановленим Nest source: emit є hot dispatch; відсутність await означає відсутність очікуваного результату, а не доведену відсутність відправки (`functions/notify-expiring.md`).
