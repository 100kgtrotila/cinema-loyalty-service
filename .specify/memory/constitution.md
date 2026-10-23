# Cinema Platform SDD Constitution

## Core Principles

### I. Minimal changes and reviewable PRs
Кожна change specification описує одну перевірювану зміну та exclusions. Використовувати чинні naming, module boundaries і залежності. Не додавати speculative abstractions, frameworks чи services без доказу потреби. Зміна framework/runtime потребує обґрунтування й окремого погодження.

### II. Transactional consistency and source-linked accounting
Пов’язані business state, ledger, dedupe та outbox/intent records комітяться атомарно. Зберігати profile locks, source links, debit-linked refunds і GOLD ownership. Helpers використовують той самий transaction client; зовнішні network calls не виконуються всередині retried transaction callbacks.

### III. Persistent idempotency
Повтори та concurrency захищаються persistent identity, constraints і транзакціями. Redis job ID не замінює DB dedupe. Не підмінювати historical result новим розрахунком і не трактувати невідомий commit/payment outcome як доведений rollback.

### IV. Reliable delivery and recovery
Приймати at-least-once delivery. Зберігати durable outbox/intents, bounded retries, recovery і claim fencing. ACK після business commit або durable quarantine. Не заявляти exactly-once. Transport outage не стирає збережений business fact.

### V. Evidence-based verification
Pure rules перевіряються unit tests; atomicity, constraints, locks і concurrency — справжнім PostgreSQL. Boundary compatibility — реальним transport test. Cross-service evidence містить exact SHA pair, exit codes і skips. Не видавати mocks за distributed verification або незапущені тести за успішні.

### VI. Explicit cross-service contracts
Власника business fact і timestamps визначати явно. Contract changes описувати до реалізації; зберігати identities, routing і public contracts, якщо зміна не обґрунтована. Репозиторії мають окремі Git histories та явний allowed scope.

### VII. Safe operations and human approval
Зберігати сторонні файли, custom skills і secrets. Destructive DB/queue/volume operations потребують окремого дозволу та перевірки target resources. Реалізація, Git publication і deployment мають окрему авторизацію. Planning не запускає implementation workflow.

## Sources and Constraints

- Engineering instructions: repository AGENTS.md та ../cinema-platform-back/AGENTS.md для backend work.
- Business source: [master specification](../../docs/loyalty-economy-architecture-spec.md). H-1…H-16 не перевідкриваються й не дублюються тут.
- Loyalty: NestJS 11, Prisma 7/PostgreSQL, Redis/BullMQ, RabbitMQ, gRPC, Bun 1.3.13, Node.js 22, Jest. Backend зберігає актуальні .NET/EF/MassTransit conventions.
- Disposable data не потребують legacy economy conversion чи dual-write; reset не дозволений автоматично.

## Development Workflow

SDD root — loyalty repository. spec.md описує WHAT/WHY і links на master; plan.md — HOW, evidence, contract і verification; tasks.md — dependency-ordered work. Для вузьких changes research/data-model/contracts/quickstart можуть бути секціями plan.md замість дубльованих файлів. Перед реалізацією читати всі три artifacts та AGENTS.md цільового repository.

Codex skills запускаються вручну; Git extension та event hooks не потрібні. Feature directory обирається через .specify/feature.json незалежно від Git branch. Не запускати implement/converge або Git side effects лише тому, що skills встановлені.

## Governance

Constitution створена з явно запитаних engineering principles і AGENTS.md. Master specification залишається джерелом бізнес-рішень. Завершення PR не переписує master автоматично. Amendments потребують явного обґрунтування, погодження й перевірки залежних artifacts. Прямі user instructions визначають дозволений scope операцій.

**Version**: 1.0.0 | **Ratified**: 2026-10-23 | **Last Amended**: 2026-10-23
