# Frozen Reference Bible Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a frozen, content-addressed visual reference bible for characters, props, environments, and style, with secure byte verification, revision binding, shot resolution, invalidation, CLI/schema support, and offline regression coverage.

**Architecture:** Keep textual story canon in `story` and actual approved reference files in a new `referenceBible` section. A pure reference-bible module validates stable IDs, safe contained paths, file signatures/bytes, canon and story revision bindings, then derives a deterministic freeze hash. Manifest validation composes those checks with shot bindings and stale-state rules; the CLI exposes an offline `references` operation without invoking providers.

**Tech Stack:** Node.js 20+, TypeScript, Vitest, Node crypto/fs/path APIs, JSON Schema draft 2020-12.

**Spec:** GitHub Issue #5 and `AGENTS.md`, with existing contracts in `docs/architecture.md` and `docs/production-contract.md`.

## Global Constraints

- Actual reference-image bytes, not filenames/prompts/metadata, are the proof of an approved image reference.
- All paths are episode-root-relative, symlink-aware, and fail closed on traversal or escape.
- Stable IDs and deterministic SHA-256 hashes bind the frozen bundle to the approved story/script revision and canon.
- Changed, missing, mismatched, or drifted references invalidate dependent shot references and downstream approval evidence.
- Tests are offline fixtures only; no image generation, provider, credit, publication, or automatic dispatch.

## Review Focus

- A symlinked reference path escaping the episode root must fail validation; test in the reference-bible suite.
- A valid-looking image extension with non-image bytes must not pass actual reference verification; test signature validation.
- Textual canon and approved image files diverging must be reported as identity drift; test canon binding.
- A changed reference byte or freeze bundle revision must make shot bindings stale; test manifest invalidation.
- Traversal/absolute paths in nested reference entries must fail closed; test CLI and manifest validation.

---

### Task 1: Reference-bible domain model and verification

**Files:**

- Create: `src/reference-bible.ts`
- Modify: `src/types.ts`
- Modify: `src/paths.ts` only if shared symlink/path behavior needs tightening
- Test: `tests/reference-bible.test.ts`

**Interfaces:**

- Produces `ReferenceBible`, `ReferenceEntity`, `ReferenceImage`, `ReferenceBundle`, `validateReferenceBible`, `freezeReferenceBible`, and `resolveReferenceImage`.
- `ReferenceImage` stores a safe relative path, actual byte SHA-256, kind, approval status, and optional dimensions/signature metadata; text-only canon is never treated as image proof.

- [ ] Write failing tests for character/prop/environment/style references, actual PNG/JPEG signature checks, missing/modified bytes, symlink escape, traversal, stable IDs, and deterministic freeze hashes.
- [ ] Implement typed reference records and pure/deterministic hash helpers, using `resolveContained` and reading file bytes for verification.
- [ ] Require each approved image to have a real supported image signature and exact SHA-256; reject prompt-only or extension-only substitutes.
- [ ] Run `npm test -- --run tests/reference-bible.test.ts` and commit the domain implementation.

### Task 2: Manifest binding, stale behavior, schema, and CLI

**Files:**

- Modify: `src/manifest.ts`, `src/cli.ts`, `src/scaffold.ts`, `src/checkpoints.ts`
- Modify: `schemas/episode.schema.json`, `README.md`, `docs/production-contract.md`
- Test: `tests/manifest.test.ts`, `tests/cli.test.ts`, `tests/checkpoints.test.ts`

**Interfaces:**

- `Episode.referenceBible` binds a bundle path/hash, story revision/canon hash, freeze hash, and state.
- Each shot gains `referenceBundleHash` and resolved character/prop/environment/style reference IDs/hashes.
- CLI `references <episode-root>` validates and records a non-provider checkpoint.

- [ ] Add failing tests for valid sample three-beat bundle, unknown IDs, canon drift, stale bundle/shot hash, and CLI JSON validation.
- [ ] Integrate reference-bible verification into `validateEpisode`, including safe file checks and downstream review invalidation.
- [ ] Include reference-bible and freeze dependencies in checkpoint input hashes; mark approvals stale on changed references.
- [ ] Extend JSON Schema and scaffold output without breaking blank offline episodes.
- [ ] Run targeted tests, then commit the manifest/schema/CLI changes.

### Task 3: Full verification and independent review

**Files:**

- Modify only files required to repair findings.
- Test: all existing and new suites.

- [ ] Run full tests, typecheck, lint, format check, build, audit, and diff checks.
- [ ] Perform independent security/path/revision review focused on symlinks, image signatures, stale hashes, and prompt-only substitutions.
- [ ] Repair findings, rerun all gates, commit the final fixes, push the isolated branch, open a PR, and add concrete evidence to Issue #5.
