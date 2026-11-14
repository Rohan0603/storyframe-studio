# Issue 2 Foundation Design

## Intent

Provide a local-only TypeScript foundation that can scaffold and validate the canonical `episode.json` without providers, credentials, media generation, or network access.

## Goals and non-goals

- Goals: strict versioned manifest validation, safe IDs and paths, non-overwriting scaffolds, durable stage/attempt checkpoints, hash-bound resume invalidation, offline fixtures/tests, and CI.
- Non-goals: image/TTS providers, FFmpeg rendering, publication, creative approval, migrations beyond rejecting unsupported schema versions, or automatic agent dispatch.

## Approaches

- A schema library would reduce hand-written checks but adds dependency and version surface for a foundation that must run offline.
- A database would improve querying but conflicts with the documented local filesystem contract.
- Chosen: dependency-light runtime validation over a typed manifest, filesystem checkpoint journal, and explicit CLI failures for unavailable provider/render stages. This keeps the first usable path deterministic and auditable.

## Design

`new` creates a complete empty episode directory and refuses to overwrite existing files. `validate` checks schema, stable IDs, duplicate references, safe relative paths, file hashes, and checkpoint consistency. `plan` records a deterministic offline planning checkpoint after validation. `resume` replays the checkpoint journal and records `stale` when current dependency hashes differ. `render` exits with a clear not-implemented error. All project paths are resolved under the selected episode root with symlink-aware containment checks.

## Constraints

Node.js + TypeScript with strict types; generated projects, media, receipts, secrets, and local state are ignored; tests use temporary directories and synthetic text/JSON fixtures only.
