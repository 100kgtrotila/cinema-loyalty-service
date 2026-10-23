# Cinema Platform SDD workflow

Spec Kit 1.0.3 is initialized only in cinema-loyalty-service. Main business source: [approved master specification](../docs/loyalty-economy-architecture-spec.md). Engineering guardrails: [constitution](memory/constitution.md). Current change: [Stage 1 / PR 1](../specs/001-authoritative-payment-facts/spec.md).

## Manual Codex workflow

Use Codex chat skills $speckit-specify → $speckit-plan → $speckit-tasks → read-only $speckit-analyze. These are agent skills, not shell commands. CLI sanity: specify version and specify integration status. No extra extensions, Git extension, automatic Git workflows or runtime event hooks were enabled. Installed implement/converge skills do not authorize their execution.

Feature location is independent of Git branch. .specify/feature.json is an ignored per-checkout pointer. If missing in a fresh checkout, select explicitly in PowerShell before the planning skill/session:

```powershell
$env:SPECIFY_FEATURE_DIRECTORY = 'specs/001-authoritative-payment-facts'
```

This does not create a branch. Start a new Codex session if installed skills are not yet in its picker. Do not rerun init --force without checking managed-file conflicts. Keep .codex/config.toml machine-local; Spec Kit events are disabled. CLI 1.0.3 may normalize that file's line endings even with events false: inspect/restore only that tool-produced change, preserving the original content.

## Cross-repository scope

Run SDD from the loyalty root. Every plan declares target repository, allowed paths and exact SHA baseline. Backend implementation uses a separately authorized clean feature checkout from current main, reads its AGENTS.md and linked loyalty artifacts. Do not initialize a second Spec Kit project or copy the master into backend. Starting Codex in backend alone does not automatically discover loyalty-root skills; use explicit handoff with these paths.

Current checked-out repositories were only read/fetched; no checkout, branch or merge was performed. The recommended future backend base is in the change plan and must be revalidated at execution time.

## Artifact ownership and approval

- Master describes agreed target business behavior; changes reference specific sections instead of copying all 33 invariants.
- spec.md is WHAT/WHY; plan.md is HOW, evidence, data model, contract and verification; tasks.md is the checklist. For this narrow change, do not produce duplicate research/data-model/contracts/quickstart documents.
- Existing change artifacts are reviewed history. Material discoveries are reconciled explicitly; completion never rewrites master automatically. Changes to approved business rules require user approval.
- Planning completes at analysis/review. Implementation, Git commit/push/PR, migrations/reset and deployment require explicit scope authorization. No automatic transition into implement/converge.
- No tests were executed as part of installation/planning; future checks are listed in the change plan.

Only generated skills and shared Spec Kit scaffolding were added. Existing AGENTS.md, custom skills, master document and MCP config were preserved. The root README has unrelated invalid UTF-8 bytes, so SDD setup instructions are kept here instead of rewriting its encoding.
