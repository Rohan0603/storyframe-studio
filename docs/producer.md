# Guided and Auto producer (Issue #8)

The producer is a **local-first, fail-closed coordination layer** around the
existing Story Skills, narration-to-shot alignment, frozen reference bible,
Codex Desktop `image_gen` handoffs, Kokoro/Gemini narration, subtitles, and
FFmpeg renderer. It does **not** invoke an unattended Codex image service,
automatically publish to YouTube, fabricate creative approval, or authorize
unbounded provider spending.

## Running a producer session

The following commands run from the repository root after `npm run build`.
Each session works on one local episode directory, and all generated material
must remain outside Git:

```powershell
node dist/src/cli.js producer "C:\path\to\episode" init guided 40 180
node dist/src/cli.js producer "C:\path\to\episode" status
node dist/src/cli.js producer "C:\path\to\episode" next
node dist/src/cli.js producer "C:\path\to\episode" approve research owner "Verified the claim/source ledger"
```

For an explicitly invoked Auto run, replace `guided` with `auto`.
`40` is the **maximum still count** and `180` the **maximum narration
seconds**. Both are mandatory. The initial producer policy authorizes **zero**
cloud TTS requests, **zero** image-generation dispatches, **zero dollars**
and **no publication**. Image prompts and Codex Desktop image generation
are still a separate explicit handoff. Local Kokoro synthesis remains an
explicit operation; the producer's status command never synthesizes speech.

The `producer` command supports:

| Action | Behavior |
| --- | --- |
| `init` | Start a single bounded, nonspending run; refuses restart/overwrite |
| `status` / `next` | Compute stage readiness from canonical episode and actual assets |
| `approve` | Append an explicit reviewer + notes, hash-bound to current inputs |
| `verify-render` | FFprobe a real MP4, verify H.264/AAC and duration, bind its SHA-256 |
| `record-review` | Import actual human QA evidence from local JSON |
| `create-captions` | Generate non-overwriting SRT from verified word alignment |
| `render` | Render approved stills/narration via FFmpeg, then verify output with FFprobe |
| `run` | In explicitly started Auto mode, produce SRT/render only when every preceding stage has real accepted evidence |
| `package` | Write a nonpublishable YouTube metadata package after all QA gates |

Example render verification:

```powershell
node dist/src/cli.js producer "C:\path\to\episode" verify-render output/video.mp4
```

Guided use: after approving the narration stage, run `producer <root> create-captions`, review and approve the captions stage, then `producer <root> render`. Auto use: after starting in `auto` mode and preparing all upstream assets, an explicit `producer <root> run` creates SRT and renders MP4 if the verified inputs and limits permit. It stops at human final QA and cannot call native `image_gen`, invoke cloud TTS or publish.

QA must be written and checked independently after listening to and watching
the actual final video. A locally written review document is required for
`record-review`. It must record a nonempty reviewer and notes, the **exact**
MP4 SHA-256 from `episode.production.render.sha256`, and a `checks`
object with nonempty evidence notes and `status: "pass"` for **each**
of `audiovisual`, `captionSync`, `storyImageMatch`, `rights`,
`originality`, `claims`, and `aiDisclosure`.
Incomplete, failed or unknown checks block packaging:

```powershell
node dist/src/cli.js producer "C:\path\to\episode" record-review qa/review.json
```

Set `episode.release.creativeApproval` through an explicit owner review,
then approve the `final-qa` stage using the same `approve` command.
Do not mistake `productionQAPassed` or a generated MP4 for owner publication
permission.

When all stages pass, provide `episode.production.youtube` metadata in
`episode.json`: `title`, `description`, `disclosure`, `tags: []`,
and `chapters: []`. Then:

```powershell
node dist/src/cli.js producer "C:\path\to\episode" package
```

The output is `output/youtube-package.json`, written without overwriting
an existing file. It explicitly sets `uploadAuthorized: false` and
`monetizationGuaranteed: false`. It **does not upload** anything.

## Production stages

1. **research:** Story Skills output and a source/claim ledger without disputed
   or unverified factual assertions.
2. **script:** Original approved script revision.
3. **beat-map:** Exact narration spans and meaningful shots.
4. **references:** Frozen image-based visual reference bible.
5. **images:** Actual decoded and SHA-bound images with pixel-semantic reviews,
   consistent characters/props/environments and approved shot status.
6. **narration:** Real hashed audio and verified word alignment, transcript
   and duration bound to the same narration.
7. **captions:** Stored SRT matches the verified alignment; no proportional
   timing labeled verified.
8. **render:** Actual FFprobe-verified HD MP4 with hash and matching duration.
9. **final-qa:** Render-hash-bound human audiovisual, synchronization, factual,
   rights/originality and disclosure checks, plus owner creative approval.

**Guided** pauses at each acceptance-ready stage until a user explicitly
records approval. **Auto** only advances through *already evidenced*
routine stages; it cannot dispatch unsupported native tools, spend quota,
or decide a rights/disclosure review passed. Even in Auto, final creative/QA
approval stays manual. Any missing evidence, provisional timing, stale hash
or invalid claim blocks progression.

Approvals are stored on the canonical `episode.json`, tied to a SHA-256
fingerprint of that stage's cumulative dependencies. A source/script, visual
reference, image, provider, audio or render change makes relevant downstream
approvals stale. The `episode.json` remains the production source of truth;
QA evidence files and reports are **inputs**, not competing manifests.

## Live validation status

The previously reported, user-approved chest/crystal pilot used real native
Codex stills and **Kokoro ONNX** narration with a 10.628-second WAV,
phoneme-derived timing, SRT and local 1920×1080 H.264/AAC MP4.
Those private assets live only on the user's machine, not in GitHub CI.
This Issue #8 implementation adds bounded orchestration and acceptance
checks, **not a new claim to have rerun that live pilot**. A genuine
longer Guided and Auto trial still requires local access to the providers
and the real image assets.

Never assume that a passing software test establishes YouTube Partner
Program monetization eligibility or grants permission to publish.
