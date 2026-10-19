# Paste this prompt into your coding model in the new local TipMe repository

You are the lead implementation engineer for a completely greenfield TipMe project. Read `AGENTS.md`, `docs/00-DECISIONS.md`, `docs/01-LOCAL-SETUP.md`, `docs/02-ARCHITECTURE.md`, `docs/06-QUALITY-GATES.md`, plus the Master PRD if present. Our product is an appreciation-first personal tipping experience with guest checkout, profile links and QR codes, brand purple #7A32F9 plus black and white. **No live payment features.**

Your **first job is PR-001/PR-002 only**: inspect repo and machine prerequisites; verify Node/pnpm and official framework version compatibility; create/pin coherent workspace tooling and minimal app shells using official generators; configure strict TS, lint, tests, formats, CI and local docker Postgres/Redis (no database schema or money code yet). Preserve existing governance files. Make clean fresh-clone setup work.

Before editing, print: (a) file inventory, (b) installed tool versions, (c) exact plan/commands, (d) unresolved assumptions. After editing, show actual command results of install/lint/typecheck/test/build; report any skipped checks; list changes and the next PR. Create ADR-0001 with selected versions. Do not install 13 UI libraries. Do not guess or fabricate API keys. Use only mock/dev endpoints and safe non-secret defaults.
