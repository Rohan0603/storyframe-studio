# Strict series production: rollout after PR #28 review

Newly scaffolded episodes enable 1920x1080, native receipt and visual-screening
policy. A legacy episode stays readable, but must not be relabeled strict by
inventing historical evidence. Before starting the next episode, inspect the
actual previous manifests, images and final appearances locally.

## Series evolution

The per-episode snapshot includes `episodeId`, `throughEpisode`, and all
character, prop and environment entities shown in the episode. Each state has
`fromEpisode`, zero-based `fromShot`, `fromBeatId`,
`scriptRevisionSha256`, exact visualCanon and approved reference ID/hash.
For a current-episode transition, the first shot carrying that beat must match
fromShot. A revised shot order requires a new approved transition mapping.

For episode order >1, configure `series.evolution.predecessor` with path,
sha256, manifestPath and manifestSha256. Archive the prior episode manifest
and prior evolution snapshot under the local episode root. The previous
manifest must record passing production QA and its exact evolution hash.
When migrating a legacy series, reconstruct the predecessor snapshot by
reviewing actual earlier story and pixels, and record legacyMigrationNotes.
The archive is not cryptographic external attestation; do not rewrite it.
Never backdate new states or delete prior history.

Use `shot-prompt <episode-root> <shot-id>` before native generation. The
packet includes the actual current state reference and prompt fingerprint.
Use that hash in dispatch and image provenance, and record
semanticReview.reviewedPacketSha256 only after reviewing current pixels.

## Image evidence

Retain original native output, raw native tool response and its actual
receipt ID. Store the native provider evidence path/hash, dispatch journal
path and SHA-256 of JSON.stringify(the exact persisted journal entry).
The journal entry binds shot ID, packet hash, native receipt ID, original
path, bytes and dimensions. It must retain providerEvidence. Do not infer
receipt IDs from shot/attempt IDs; unavailable native evidence is a blocker.

Run `normalize-still` on native bytes when needed; keep returned native
metadata and normalization receipt path/hash. Run `screen-still` on the final
1080p file; the command returns persisted evidence path/hash. In human
review, clear actual unwanted text/collage status and explicitly list any
permitted OCR-detected diegetic signage in allowedText. Unknown OCR or
suspected panels remain blocked. The heuristic is not a substitute for
independent pixel review.

## Audio and sync

Supply `phraseSpans` (exact approved transcript startChar/endChar pairs) to
`synthesizeKokoroTts` to synthesize each segment locally in one model process
and measure cumulative PCM samples. Persist its alignmentSha256 in narration.
Phrase cue boundaries must match these measured spans; group-count-only
Kokoro word candidates are unverified. Verified word mode requires real
lexical mapping or reviewed word evidence, not equal counts. Listen to the
whole narration and inspect the actual video. The strict renderer validates
the same manifest and rounds absolute cut positions to 30 fps.

## Publication

Only after a separately user-authorized YouTube action, bind the intended
video ID, scheduled/public state, exact schedule if applicable, local approved
video path and SHA under release.youtubeTarget, plus the existing recorded
publishAuthorization. Run verify-youtube with an owner read-only OAuth token.
The command records the API receipt and hash in the episode manifest, never
publishes. A past scheduled receipt proves historical scheduling, not that
the video is currently public: recheck actual public status.

Keep all private scripts, images, evidence, tokens and local episode manifests
outside the public repository. No provider fallback or fabrication is allowed.
