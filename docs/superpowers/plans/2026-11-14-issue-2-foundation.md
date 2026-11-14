# Issue 2 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the no-spend offline Node/TypeScript foundation described by GitHub issue #2.

**Architecture:** A small CLI delegates to pure manifest/path/ID validation and a filesystem checkpoint journal. Provider-facing commands fail explicitly; no external service is imported or called.

**Tech Stack:** Node.js, TypeScript, Vitest, ESLint, Prettier, GitHub Actions.

**Spec:** `docs/production-contract.md` and GitHub issue #2.

## Global Constraints

- `episode.json` is the sole canonical episode-production manifest.
- No provider calls, billable operations, publication, secrets, or generated media.
- Unsafe paths, malformed IDs, duplicate shots, missing hashes, stale dependencies, and conflicting state fail closed.
- Existing approved files are never overwritten by defaults.

## Review Focus

- Windows/absolute/traversal/symlink paths must not escape the episode root.
- Duplicate IDs and malformed IDs must be rejected before filesystem mutation.
- Hash changes must stale derived checkpoints without deleting approved outputs.
- `render` must fail explicitly and never imply a render happened.
- A second `new` invocation must not overwrite user files.

### Task 1: Project and manifest contracts

**Files:** `package.json`, `tsconfig.json`, `src/types.ts`, `src/ids.ts`, `src/paths.ts`, `src/manifest.ts`, `tests/manifest.test.ts`

- [ ] Write failing tests for valid blank manifests, malformed/duplicate IDs, unsafe paths, hash mismatch, and symlink escape.
- [ ] Implement strict types, stable ID checks, containment-aware paths, SHA-256 helpers, and runtime manifest validation.
- [ ] Run targeted tests and typecheck.

### Task 2: Scaffold and checkpoint state

**Files:** `src/scaffold.ts`, `src/checkpoints.ts`, `tests/state.test.ts`

- [ ] Write failing tests for non-overwrite scaffolding, durable attempt records, resume hash invalidation, and conflicting checkpoint state.
- [ ] Implement deterministic scaffold creation and append-only checkpoint replay/invalidation.
- [ ] Run targeted tests and full suite.

### Task 3: CLI and repository hygiene

**Files:** `src/cli.ts`, `.gitignore`, `.github/workflows/ci.yml`, `tests/cli.test.ts`, `README.md`

- [ ] Write failing CLI tests for `new`, `plan`, `validate`, `resume`, and explicit `render` failure.
- [ ] Implement command parsing with no provider side effects and wire lint/format/typecheck/test scripts.
- [ ] Add ignored local-data patterns and CI matrix.
- [ ] Run exact test, lint, format-check, typecheck, and offline CLI checks.
