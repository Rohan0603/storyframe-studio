# Implementation roadmap

> Tasks below are planned, **not yet completed**. Start with offline proofs and an independent quality gate. All provider calls require separate authorization.

## Phase 0 — repository foundation (P0)

- [ ] Review and approve `README.md`, `AGENTS.md`, architecture and schema specification.
- [ ] Establish clean TypeScript/Node.js project, lockfile, formatting/lint/type checks and CI.
- [ ] Add `.gitignore` for projects, generated media, credentials, receipts and local secrets.
- [ ] Add schema validation, stable IDs, safe paths and versioned migration policy.
- [ ] Create CLI for `new`, `plan`, `validate`, `resume`, `render`; CLI must not secretly call providers.
- [ ] Add offline, deterministic stage checkpoints and tests.

**Exit:** a blank project can be created and validated offline, with no Boords/Flow or paid API dependency.

## Phase 1 — story and research (P0)

- [ ] Pin a license-compliant version of `danjdewhurst/story-skills`; select only needed skills.
- [ ] Add source-backed claim ledger with verified/disputed/unknown status.
- [ ] Produce original narration script, speaker identities, series bible and continuity metadata.
- [ ] Add `narration-visual-alignment`: map script exact text spans to narrative beats and meaningful shot requests.
- [ ] Validate narration coverage and deliberate holds; reject unsourced factual assertions and random-image prompts.

**Exit:** a researched 60–90-second original story generates a coherent beat/shot plan **without images**.

## Phase 2 — reference images and imagegen (P0)

- [ ] Build character, prop, environment and visual-style reference registries with stable IDs and SHA-256.
- [ ] Freeze reference bundle before full scene production.
- [ ] Verify **actual Codex Desktop built-in `image_gen`** capability: reference attachments, output ingestion, image dimensions, local save path, batch limit and observable usage/quota.
- [ ] Build per-shot prompt packets from narration beat + frozen references, not topic-only keywords.
- [ ] Persist output SHA/provenance; support selected failed-shot regeneration and safe retries.
- [ ] Implement independent **actual-pixel image/story-match QA** and continuity review; fail closed if unavailable.
- [ ] Prototype both recommended and custom image counts, with cinematic default 14–18/min adjusted by real story needs.

**Exit:** exact three-shot chest/crystal/room-shaking test rejects irrelevant stills and locks only inspected consistent images. Explicitly approved live test required; no claim based only on mocks.

## Phase 3 — voice, synchronization and renderer (P0)

- [ ] Verify live Google Gemini expressive TTS model and current billing terms; no key in repo.
- [ ] Generate transcript-exact segmented narration and stable character voices.
- [ ] Create verified audio alignment with shot time boundaries and caption timestamps.
- [ ] Add FFmpeg still assembly and FFprobe metadata/decode checks; save MP4 + SRT.
- [ ] Reject bad synchronization, dead air from unplanned holds, mismatched captions and black flashes.

**Exit:** offline synthetic E2E passes; one explicitly authorized real short episode has image/story/audiovisual review evidence.

## Phase 4 — Guided and Auto producer (P1)

- [ ] Guided checkpoints for story, script, beat map, references, images, voice and final export.
- [ ] Auto mode policy engine with maximum episode duration, images, budget, retries and stage permissions.
- [ ] Separate external-charge authorization and final publication permission from routine workflow approval.
- [ ] Crash recovery, ambiguous provider-result reconciliation, durable checkpoints, precise invalidation and resume tests.
- [ ] Clear fallback when Codex Desktop image_gen is not invokable unattended: pause for manual/local Codex handoff; **no fake automation**.

**Exit:** Guided end-to-end works with real reviewed images, and bounded Auto completes where the installed client actually supports required operations.

## Phase 5 — release and channel readiness (P1)

- [ ] Licensing/provenance, fact checking and required synthetic-content disclosure checklist.
- [ ] Originality/repetitiveness and YouTube-readiness report; do not promise monetization.
- [ ] Thumbnail, description, title, chapters and caption packaging.
- [ ] Human creative/release approval independent of technical QA.
- [ ] No direct YouTube publication until an explicit separately scoped owner decision.

## Engineering execution policy

Record each phase in scoped GitHub issues with acceptance criteria, test evidence and responsible roles. Owner invokes Chief/Worker manually; no automatic agent-dispatch on GitHub events. Create branch/PR, run exact-head CI, review independently and merge only when authorized. Keep the former StickmanDirector repository and its Trello cards completely separate.
