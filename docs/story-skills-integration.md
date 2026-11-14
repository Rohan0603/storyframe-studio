# Story Skills integration boundary

Issue #3 uses a small, local adapter around selected upstream skill files. The
adapter never invokes the upstream CLI and does not vendor publishing,
submission, adaptation, or other unrelated machinery.

The immutable upstream record and MIT attribution are in
`assets/story-skills/manifest.json` and `assets/story-skills/NOTICE`:

- URL: `https://github.com/danjdewhurst/story-skills`
- commit: `33085ccc3ceb94a6ff9362cf499091123cdfb30d`
- version: `0.25.0`
- selected names: premise-workshop, research, plot-structure,
  character-management, worldbuilding, scene-craft, voice-style,
  revision-continuity, story-maintenance, series-continuity
- license: MIT, Copyright (c) 2026 Daniel Dewhurst

`selectSkills(stage)` returns only the stage-relevant names. The
`loadSelectedSkills(stage, skillRoot)` adapter then reads only those
`<skillRoot>/<name>/SKILL.md` files and returns a trace, making token-minimal
selection observable in offline tests. The caller supplies the upstream
checkout or another reviewed skill directory; no network access occurs here.

## Story data boundary

The optional `episode.story` section carries an original normalized script
revision, stable speaker IDs, source/claim ledger, series character/prop canon,
and exact `beatCandidates`. Canonical `episode.beats` remains the production
manifest's exact spoken-span handoff for Issue #4; no image generation or
alignment is performed by this layer.

Claim statuses are `verified`, `disputed`, or `open`. When factual release
acceptance is requested, every claim must be verified. Character/prop state
changes must be explicit transitions; contradictory same-beat observations
fail deterministic validation.
