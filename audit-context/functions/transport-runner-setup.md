## DB setup entrypoint — test/run-transports.mjs L100–115

**Purpose:** Окрема DB outbound/RPC tests, щоб application cron не забирав їхні outbox rows L101–102. Аналіз function_b, запис координатора.

**Inputs & Assumptions:** URL з random loopback endpoint L87; project містить pid L6; config guards L58–73 забороняють volume mounts/fixed або nonlocal ports. Право CREATE DATABASE — передумова query, окрема перевірка: `nothing found`.

**Outputs & Effects:** Створює loyalty_outbox_transport, мігрує, передає URL через E2E_OUTBOX_DATABASE_URL L105–115.

---

**Block-by-Block:** L100 мігрує основну DB. L103–108 Pool створює другу DB, finally pool.end навіть при CREATE failure. L109–111 змінюється лише pathname URL. L112–115 migrate deploy з окремим child DATABASE_URL. Немає зміни tracked monolith files.

---

**Cross-Function Dependencies:** Незмінений run L29–34 кидає при nonzero/spawn error. Outer catch L132–140 збирає log, finally L141–147 зупиняє тільки Compose project цього runner. Endpoints обмежені loopback L35–44; фактичний Compose resolved config — external tooling boundary.

**Open Questions:** Docker availability та фактичні ресурси цього запуску статичне читання не підтверджує. Runner/тести не запускалися.
