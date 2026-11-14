# Issue #6 Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a fail-closed Codex Desktop `image_gen` workflow with deterministic shot packets, secure image ingestion/receipts, bounded batches, and actual-pixel QA.

**Architecture:** Keep the TypeScript core provider-agnostic at the boundary: the Work runtime supplies the native Desktop invoker, while the repository never shells out or substitutes another image service. Persist dispatch/receipt state before and after calls, validate PNG bytes through signature, dimensions, hash, and decode checks, and require an independent pixel-inspection result before approval.

**Tech Stack:** Node.js 20, TypeScript, Vitest, native `node:fs/promises`, `node:crypto`, and `node:zlib`.

**Spec:** GitHub Issue #6 and `docs/production-contract.md`.

## Global Constraints

- Native Codex Desktop `image_gen` is the only live provider path.
- Unknown capability, quota, charge, persistence, decode, or pixel-review state fails closed.
- No Flow, Boords, OpenAI image API, Google image API, shell provider calls, mocks, or fixtures may be reported as live output.
- Generated media, receipts, projects/output, and secrets stay ignored.
- No paid call, publication, merge, or extra agent dispatch.

## Review Focus

- Exact span mismatch: packet creation rejects text not sliced from the approved script.
- Symlink/path race and replacement: ingestion re-checks contained path and bytes before recording approval.
- Truncated/forged image: ingestion rejects bad signature, dimensions, or PNG decode.
- Unknown billing or ambiguous return: gate/receipt remains blocked or unknown and preserves evidence.
- Attractive but unrelated pixels: QA rejects when inspected observations do not satisfy the shot contract.

### Task 1: Contracts and prompt packets

**Files:** `src/types.ts`, `src/image-generation.ts`, `tests/image-generation.test.ts`

- [ ] Add typed capability, packet, batch policy, receipt, inspection, and result contracts.
- [ ] Test exact narration slicing, frozen reference binding, crop, and deterministic packet hash.
- [ ] Implement packet creation and fail-closed capability preflight.

### Task 2: Secure image ingestion and receipts

**Files:** `src/image-generation.ts`, `src/paths.ts`, `tests/image-generation.test.ts`

- [ ] Test safe output containment, PNG signature/dimensions/decode, SHA-256, and preservation of unknown/rejected originals.
- [ ] Implement atomic candidate persistence, receipt transitions, retry bounds, and reconciliation states.

### Task 3: Pixel-semantic QA and manifest integration

**Files:** `src/image-generation.ts`, `src/manifest.ts`, `schemas/episode.schema.json`, `tests/image-generation.test.ts`, `tests/manifest.test.ts`

- [ ] Test pass/reject/unknown outcomes for missing pixels, off-story action, missing crystal, identity drift, unwanted text, and stale bindings.
- [ ] Require image provenance/review bindings in episode validation without accepting text-only evidence.

### Task 4: CLI/docs and live capability handoff

**Files:** `src/cli.ts`, `README.md`, `docs/architecture.md`, `docs/production-contract.md`, `.gitignore`

- [ ] Add a non-provider `image-preflight`/`image-plan` path that records BLOCKED when native capability/quota/charge state is unknown.
- [ ] Document the real-pilot seam and the exact runtime blocker; never label offline fixtures as live.

### Task 5: Verification

- [ ] Run targeted tests, full `npm test`, typecheck, lint, format check, build, audit, and diff checks.
- [ ] Perform an independent read-only self-review of security, scope, and fail-closed behavior.
- [ ] Commit a PR-ready branch without creating or merging a PR.
