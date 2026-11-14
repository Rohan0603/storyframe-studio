# Architecture — StoryFrame Studio (design)

## Purpose

Build an original narration-first production pipeline, not a slideshow generator. **Audio/story meaning determines the shot plan; approved visual evidence determines whether a shot can appear in the video.**

The system consists of a local Node.js/TypeScript orchestration layer, pure stage contracts, filesystem storage, Codex Desktop image generation, Gemini expressive TTS, FFmpeg/FFprobe and selective third-party Story Skills integration.

No Boords, Flow or reused legacy runtime dependency.

## Boundary diagram

```text
Topic -> Research -> Story Skills adapter -> script.md + source ledger
                                      |
                                      v
                         Narration beat segmentation
                                      |
                                      v
                     Beat-to-shot contract in episode.json
                                      |
                       +--------------+--------------+
                       |                             |
                       v                             v
             Frozen visual bible              Exact narration text
                       |                             |
                       v                             v
             Codex Desktop image_gen         Gemini expressive TTS
                       |                             |
                       v                             v
             Saved actual image bytes        WAV + measured alignment
                       |                             |
                       +------------+----------------+
                                    |
                                    v
                      Shot/voice time reconciliation
                                    |
                                    v
                     Pixel-semantic QA + continuity QA
                                    |
                                    v
                       FFmpeg / FFprobe + SRT
                                    |
                                    v
                  Final audiovisual + release QA report
```

The visual-reference bible is frozen **before** scene image generation. TTS can be synthesized after the approved script, but final scene boundaries cannot be accepted until actual audio timing is available.

## Components

### Research and story adapter

- Use **selected** `danjdewhurst/story-skills` skills, version pinned: `premise-workshop`, `research`, `plot-structure`, `character-management`, `worldbuilding`, `scene-craft`, `voice-style`, `revision-continuity`, `story-maintenance` and `series-continuity` when relevant.
- Read skills only for the active stage to minimize token use.
- Preserve Markdown/YAML story source and source-linked claim ledger; do not import novel-publishing or unrelated skills.
- Integration design must pin a revision, document tested Node/Codex compatibility, and carry MIT attribution if copying upstream content.

### Beat and shot planner (the central module)

Separate **narrative beats** (meaningful spoken events/claims) from **shots** (one still and on-screen time range). Allow 1 beat -> many shots and deliberate 1 shot -> several closely related beats with an explicit mapping. Do not assume one sentence = one image or a universal seconds-per-image rule.

A production shot must specify exact script revision, source narration span, planned/actual audio range, narrative change, what should appear in pixels, required characters/props/environment, camera composition, exclusions, selected image, image-source provenance and visual QA.

No orphaned narration range unless documented as intentional visual hold/transition; no orphan image without a matching narrative purpose.

### Reference/visual continuity manager

- Character: stable ID, silhouette/head/body proportions, clothes, colors, accessories, expressions, visual reference paths/hashes, state changes.
- Prop: stable ID, geometry, scale, texture/color, ownership, transformations, reference hashes.
- Environment: stable location and lighting anchors.
- Style: reference palette, line weight, aspect ratio, negative-space/caption-safe framing.
- Frozen content-hashed bundle. Any approved canon update invalidates affected shot prompts/images and downstream QA.

### Image provider: Codex Desktop built-in image_gen

This is a **tool-backed human/agent workflow**, not an assumption of a public HTTP API. The adapter should prepare deterministic per-shot task packets including reference files and requested output path. Only the running Codex agent may call its available built-in `image_gen` tool. After return, an ingest layer validates the saved file signature, actual dimensions, SHA-256 and correspondence to the attempt. The tool's capability and save path must be verified at runtime.

Where unattended invocation, reference handling, file persistence, batch return or usage metering is unavailable, stop at a durable handoff/checkpoint. A JSON prompt alone is not an image result.

### Voice provider: Gemini TTS

- Resolve the live available expressive TTS model rather than hard-coding a promise of availability.
- Stable speaker-to-voice mapping. Generate script-exact segments with explicit delivery metadata.
- Save verbatim request transcript, audio file hash, receipt and verified duration.
- Segment/word-level alignment for shot timing and captions; manual verified alignment allowed. Never use an unlabeled timing guess for production QA.
- No external call until quota, account authorization and possible charges are understood.

### Media engine

FFmpeg renders still frames with optional subtle non-generative holds, pans/zooms, cuts and rights-cleared audio. FFprobe checks decoded video/audio properties and duration. Produce H.264/AAC 1920x1080 30fps MP4 and SRT by default. User-specified aspect presets, including 9:16, require separately validated support. No mandatory animation and no AI video clips.

### QA / release engine

Four separate results:
1. deterministic validation of manifest references/hashes/coverage/order/timings;
2. **semantic visual audit of actual pixels versus narration intent**, with findings and revisions;
3. full-video audio/visual/subtitle quality review;
4. licensing, disclosure and YouTube-readiness review (not monetization approval).

Technical passes never automatically constitute creative signoff, and neither means publication authorization.

## Local storage and privacy

The canonical episode manifest is `projects/<series>/episodes/<episode>/episode.json`. Source script and references are local Markdown + media files; `storyboard.md` is a generated human-readable view, not a separate source of truth. A durable checkpoint/receipt file tracks stage/attempt transitions without inventing approvals. Avoid a database until an actual scaling need is demonstrated.

Data policy: commit only reusable code, templates, documentation and sanitized tests; keep actual projects, credentials, generated images/audio/videos and private receipts ignored unless the owner explicitly approves publishing specific content.

## Failure/resume and mode behavior

- A task is idempotent in the **local state machine**, but upstream provider requests are *not* presumed idempotent or free.
- Record each dispatch before attempting a billable call; ambiguous outcome is `unknown` and needs reconciliation.
- Resume without overwriting approved assets. Retry only chosen failed shots and retain rejected candidates for diagnosis.
- Guided mode pauses for review at each creative checkpoint. Auto mode can make ordinary creative choices within an explicit prior budget/permission envelope, but never bypass unavailable tool, rights, risk or publish gates.
- Creative revisions invalidate only affected dependent shots where safe and provable.

## Quality demonstration

Use an original scene: person opens an old chest -> sees a blue crystal -> touches crystal and room shakes. Require accurate aligned images, unchanged character/chest/crystal, ordered cuts and audio-matched captions. Tests must deliberately supply an unrelated image, swap shot order and change prop color, expecting failure rather than a technically valid video.
