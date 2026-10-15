## Script entrypoint — scripts/codebase-memory.ps1 L1–51

**Purpose:** Локальний status/index/search wrapper. Аналіз function_b, запис координатора.

**Inputs & Assumptions:** ValidateSet Action/Mode, defaults status/full L1–7. Binary з PATH L11, repo root із script path L10, project name із нормалізованого repo path L12. Binary version/provenance тут не pinned.

**Outputs & Effects:** Створення `.tmp/codebase-memory`, env budget256/workers2 L18–21. Це передані параметри, не доказ actual memory ceiling.

---

**Block-by-Block:** Зберігає env L13–15. Index L24–31: config auto_index/auto_watch true із exit guards, index_repository mode та persistencefalse. Search L33–37: nonempty query/limit5. Status L39–40: index_status. Ненульовий exit → throw L43–45. Finally відновлює env L47–51, не видаляє cache/settings.

---

**Cross-Function Dependencies:** `codebase-memory-mcp.exe` external black box. Внутрішня семантика full/persistence/autowatch/budget не доведена script. Команди не виконувалися.

**Open Questions:** Версія binary, scope config та lifetime auto-watch process; фактичні ресурси memory helper — окрема operational перевірка, не service runtime guarantee.
