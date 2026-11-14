# StoryFrame Studio

**Narration-first, research-backed still-image video production for YouTube.**

StoryFrame Studio is a planned local-first system that turns a topic or original story into a visually coherent, narration-driven video. It uses selected [Story Skills](https://github.com/danjdewhurst/story-skills) capabilities for writing and continuity, **Codex Desktop's built-in `image_gen`** for still images, **Google Gemini expressive TTS** for narration, and **FFmpeg** for final assembly.

> **Project status: foundation/specification.** This repository is not yet an implemented end-to-end production tool. All referenced stages and commands below are design targets unless explicitly labeled implemented.

## The non-negotiable rule

**Every final image must depict the specific narration beat that plays with it.** Beautiful but unrelated artwork is a failed shot, not acceptable filler. A valid FFmpeg export is not proof of narrative quality.

The intended sequence is:

```text
Topic / premise
  -> source-backed research
  -> original script + continuity
  -> narration beats + shot map
  -> character / prop / location reference bible
  -> Codex image_gen stills tied to shot requirements
  -> pixel-based visual / continuity review
  -> Gemini expressive narration + measured audio alignment
  -> time-accurate captions
  -> FFmpeg MP4 + SRT
  -> audiovisual and YouTube-readiness review
```

## Two production modes

|                       | Guided                           | Auto                                              |
| --------------------- | -------------------------------- | ------------------------------------------------- |
| Story decisions       | User reviews each creative stage | Agent makes routine decisions                     |
| Script and references | Explicit creative approval       | Preauthorized policy, auditable evidence          |
| Images                | Shot-by-shot or batch review     | Bounded generation + independent image inspection |
| Revisions             | User chooses corrections         | Retry only failed shots within limits             |
| Provider spending     | Per-batch authorization          | Explicit upfront budget/capability authorization  |
| YouTube publication   | Separate owner approval          | **Not automatic** in initial releases             |

An automatic _production run_ is not permission to automatically dispatch development agents or purchase more quota.

## Visual impact: enough stills, but never random padding

The **cinematic** default _planning target_ is **14–18 distinct stills per minute** (an eight-minute video may plan roughly 112–144 frames). Reflection-heavy sections may use fewer, action-heavy sections more. These are **planning heuristics, not guaranteed or mandatory counts**. Shot count follows meaningful narration/action beats, pacing and image-generation budget. A selected shot may be held for an intentional duration; no generic filler is allowed. Freeze the shot plan before full image generation and re-time it to accepted audio.

## Providers and boundaries

- **Writing:** selectively reuse upstream Story Skills via a pinned, license-compliant integration; do not load all its skills into every prompt.
- **Images:** the intended primary tool is the **built-in `image_gen` available inside Codex Desktop**, not a shell command, Flow, Boords, or an OpenAI API key. Its exact invocation, ability to accept reference images, return downloadable files and operate unattended must be verified in the installed client before claiming automation. Codex/ChatGPT metering must be checked against current account usage, not inferred from a past test.
- **Audio:** Gemini expressive TTS, subject to live model/access/billing verification and explicit authorization; no embedded credentials.
- **Video:** local FFmpeg/FFprobe, still images only, plus narration/captions and optional rights-cleared sound.
- **State:** Markdown for human-readable creative records; a versioned `episode.json` as the canonical episode-production contract. No Boords dependency.

## Initial target structure

```text
AGENTS.md
README.md
docs/
  architecture.md
  production-contract.md
  roadmap.md
src/                  # future implementation
tests/                # future implementation
projects/             # local, ignored production assets
  <series>/
    series-bible/
    references/
    episodes/<episode>/
      script.md
      episode.json
      storyboard.md     # generated human-readable projection
      images/
      audio/
      captions/
      exports/
```

The repository should only version code, templates and non-sensitive documentation by default. Generated media and private project content remain local unless the owner explicitly chooses otherwise.

## Quality and YouTube goals

The pipeline must check research claims, original narrative value, character and prop consistency, **actual image-versus-spoken-beat correspondence**, source provenance, audio/caption timing, and rights/AI-disclosure considerations. No system can guarantee YouTube Partner Program eligibility or monetization.

## Where to start

1. Review [the agent/governance rules](AGENTS.md), [architecture](docs/architecture.md) and [production contract](docs/production-contract.md).
2. Work through the ordered [implementation roadmap](docs/roadmap.md).
3. Implement a **no-spend offline pilot** with synthetic stills and audio alignment before calling live services.
4. Only claim a true Codex `image_gen` integration after a real, explicitly authorized client-capability test.

**Development agents are manually invoked.** A GitHub event, label or issue state never launches one automatically. All external generation and publication permissions are separate.

## Offline foundation

The issue #2 foundation provides a no-spend CLI. After installing dependencies, build with `npm run build`, then use `new`, `validate`, `plan`, or `resume` against an episode directory. `render` fails explicitly because media providers and rendering are not implemented in this offline phase.

## Story development layer

Issue #3 adds a selective Story Skills boundary and offline story data
validators. See [the integration contract](docs/story-skills-integration.md).
The optional `episode.story` section preserves normalized script revisions,
stable speaker IDs, source claims, continuity canon, and exact beat candidates
for future beat-to-shot alignment; it does not generate images or audio.

## Frozen visual reference bible

Issue #5 adds an explicit `referenceBible` contract for approved character,
prop, environment and style references. The story canon remains textual
continuity data; an approved visual reference is proven only by reading the
actual local image bytes, checking a supported image signature, and matching
its SHA-256. Freeze hashes bind those files to the story revision and canon.
Changed, missing, unsafe or drifted references fail closed and invalidate
dependent shot bindings. The offline `references` CLI command records this
verification without contacting an image provider.

## Issue #6 image-generation boundary

Image generation is gated at the native Codex Desktop `image_gen` boundary.
The repository prepares exact-span shot packets and validates returned PNG bytes,
dimensions, hashes, provenance, receipts and independent pixel-review evidence.
`image-preflight` is fail-closed until the running Desktop client verifies native
availability, approved reference-image inputs, output persistence, quota and
charge state; it never calls a provider or substitutes another service. Unknown
receipts are reconciled rather than retried, and rejected/unknown output bytes
are preserved under ignored local attempt storage.
