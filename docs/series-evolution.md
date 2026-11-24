# Evolving series references and production hardening

This specification extends the existing `series` option. It does **not** replace
the canonical `episode.json`, old visual reference bundles, or the audio-locked
`syncTimeline`. Older episodes remain readable; newer episodes can opt into
strict quality rules.

## Why a series needs states, not one portrait

A recurring identity stays `hero` even as its appearance changes.

| Story point | State | Active image reference |
| --- | --- | --- |
| Episode 1 start | `ragged` | `hero-ragged` |
| Episode 3 shots 0–1 | `ragged` | `hero-ragged` |
| Episode 3 shot 2 onward | `wealthy` | `hero-wealthy` |

The gold-filled satchel may change in shot 1, **before** the character changes
clothes in shot 2. State transitions are independent per character, prop, or
environment; a global series revision is insufficient.

Freeze a **local episode snapshot** under `series-bible/visual-evolution.json`:

```json
{
  "version": 1,
  "seriesId": "series-journey",
  "entities": [
    {
      "entityId": "hero",
      "kind": "character",
      "states": [
        {
          "id": "ragged",
          "fromEpisode": 1,
          "fromShot": 0,
          "referenceId": "hero-ragged",
          "referenceSha256": "ACTUAL_SHA256_OF_APPROVED_RAGGED_IMAGE",
          "visualCanon": "Threadbare coat and torn shoes",
          "changeReason": "Story opening"
        },
        {
          "id": "wealthy",
          "fromEpisode": 3,
          "fromShot": 2,
          "referenceId": "hero-wealthy",
          "referenceSha256": "ACTUAL_SHA256_OF_APPROVED_NEW_SUIT_IMAGE",
          "visualCanon": "Tailored suit and polished shoes",
          "changeReason": "Found gold and bought new clothes"
        }
      ]
    }
  ]
}
```

The example SHA strings are explanatory placeholders: replace with actual
64-character lowercase hashes. `fromShot` is **zero-based** within the
episode; `fromEpisode` is an explicitly configured one-based episode order,
not lexical sorting of filenames. Sort each entity's states by effective time.
Never reuse an earlier state reference ID or its image hash for a material
appearance change.

In `episode.json`, keep existing series metadata and add:

```json
{
  "series": {
    "seriesId": "series-journey",
    "revisionId": "series-revision-03",
    "biblePath": "series-bible/series.json",
    "bibleSha256": "ACTUAL_SHA256",
    "visualFormat": "3d-still",
    "applied": true,
    "evolution": {
      "path": "series-bible/visual-evolution.json",
      "sha256": "ACTUAL_SHA256",
      "episodeOrder": 3
    }
  }
}
```

Every relevant shot binds the state **and** current approved reference:
```json
{
  "seriesBinding": {
    "seriesId": "series-journey",
    "revisionId": "series-revision-03",
    "entityStates": { "hero": "wealthy" }
  },
  "referenceBinding": {
    "freezeSha256": "ACTUAL_FROZEN_BIBLE_SHA256",
    "storyRevisionId": "script-revision-03",
    "referenceIds": ["hero-wealthy"],
    "referenceHashes": { "hero-wealthy": "ACTUAL_SHA256" }
  }
}
```

These fragments omit other required shot/episode fields. The referenced image
must also exist in the current **approved** visual reference bible, whose
actual bytes are hash checked. A correct state name alone is not proof of
correct generated pixels. The generator packet now carries `activeSeriesStates`
and binds it to its packet hash, and the pixel reviewer must compare the
result against the **current** reference.

A shot at or after the transition with `hero-ragged` will fail validation.
Likewise, a shot that combines `hero-ragged` and `hero-wealthy` references
fails rather than blending the old and new appearance. Past episodes keep
their own frozen snapshots; a future state cannot rewrite them.

Flashbacks should use a separate reviewed story-time override contract when
supported; do not bypass state checks by silently supplying an obsolete image.

## Image quality for new episodes

Enable the optional gate in `episode.json`:

```json
{
  "imagePolicy": {
    "width": 1920,
    "height": 1080,
    "requireNativeReceipt": true,
    "requireVisualScreening": true
  }
}
```

Use the CLI from the repo root (after build):

```powershell
node dist/src/cli.js normalize-still "<episode-root>" "images/native/shot-a.png" "images/shot-a.png"
node dist/src/cli.js screen-still "<episode-root>" "images/shot-a.png"
```

Normalization uses local FFmpeg, **does not overwrite** the native input, and
returns original/final paths, dimensions and hashes. Store both in image
provenance (`nativeImage` for original). The final reviewed file must be
exactly 1920×1080. If Codex exposes a genuine native generation receipt ID,
store it as `nativeReceiptId`; `attemptId` is a local journal identifier
and must never be presented as the native provider receipt.

The scanner detects obvious straight multi-panel gutters using FFmpeg pixel
data and optional offline Tesseract OCR for unintended readable text. The
result can be `clear`, `suspected`/`detected`, or `unknown` if tooling is
unavailable. `clear` is only a heuristic: **independent actual-pixel review
is still mandatory** for collages, logos, texts, composition, current
appearance and the narrated event. The strict QA gate requires a signed-off
`semanticReview.screening` bound to the final image SHA. Do not record
`clear` without inspecting ambiguous artwork; fail closed on unknown.

## Narration synchronization

Kokoro may yield word-level timings when every transcript token matches its
phoneme timing group. Set `granularity: "word"` only for that case.
If only sentence/phrase cues have actually been measured, set
`granularity: "phrase"`, record phrase timings and evidence notes, and
generate captions from verified `syncTimeline` cues—not a made-up word SRT.

## Read-only YouTube state check

After the owner has authorized and executed a scheduling or publish action,
verify the actual status via YouTube Data API v3, using a read-only OAuth token:

```powershell
$env:YOUTUBE_ACCESS_TOKEN = "<owner-readonly-OAuth-token>"
node dist/src/cli.js verify-youtube "<episode-root>" "hlQVQ_jdwvI" scheduled "2030-02-03T04:05:00Z"
node dist/src/cli.js verify-youtube "<episode-root>" "hlQVQ_jdwvI" public
```

The sample date is illustrative. A scheduled video is verified against
`status.privacyStatus=private` and its exact future `status.publishAt`.
Public verification checks `privacyStatus=public`. Any API failure or
mismatched state blocks a success claim. The command writes a local receipt
but **never** schedules, uploads, publishes, or logs the OAuth token.
For API behavior, see
https://developers.google.com/youtube/data/reference/rest/v3/videos .

## Migration / rollout

- Episodes 1–3 continue working without `series.evolution` or `imagePolicy`.
- Enable evolution/strict QA on the next local episode only after building
  approved changed-state visual reference images and freezing their hashes.
- New appearance transitions invalidate affected upcoming prompts/images/pixel
  reviews, not prior released videos.
- Do not check private series scripts, character art, reference snapshots or
  generated media into public GitHub.
