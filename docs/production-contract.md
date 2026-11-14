# Episode production contract — initial specification

This document is **proposed schema behavior**, not currently executable code. Implement a JSON Schema and runtime validators before declaring support.

## Canonical data ownership

One versioned `episode.json` controls production shot ordering, references, audio alignment, review and release evidence. Story source, research notes and captions may live in separate files referenced by hash/path; they do not independently override the manifest. `storyboard.md` is a projection.

The distinction between a narration **beat** and a visual **shot** is mandatory: one beat may have multiple distinct visual stills, and a planned hold can span several tightly linked beats without introducing an off-story image.

## Suggested scene shape

```json
{
  "schemaVersion": 1,
  "episodeId": "episode-01",
  "mode": "guided",
  "script": {
    "path": "script.md",
    "sha256": "PLACEHOLDER_64_HEX_SHA256",
    "approved": false
  },
  "referenceBundle": {
    "path": "references/bundle.json",
    "sha256": "PLACEHOLDER_64_HEX_SHA256"
  },
  "narration": {
    "provider": "gemini-tts",
    "textSha256": "PLACEHOLDER_64_HEX_SHA256",
    "audioPath": "audio/narration.wav",
    "alignmentPath": "audio/alignment.json",
    "alignmentVerified": false
  },
  "beats": [
    {
      "id": "beat-003",
      "spokenText": "The moment he touched it, the room began to shake.",
      "scriptStartChar": 202,
      "scriptEndChar": 255,
      "sourceClaimIds": []
    }
  ],
  "shots": [
    {
      "id": "shot-003a",
      "beatIds": ["beat-003"],
      "audioStartMs": 12400,
      "audioEndMs": 14700,
      "requiredVisualEvent": "Traveler touches the glowing blue crystal inside the open wooden chest.",
      "characters": ["traveler"],
      "props": ["chest", "blue-crystal"],
      "environment": "stone-room",
      "composition": "Medium close-up with hands and crystal visibly connected.",
      "forbidden": ["missing crystal", "different room", "extra people", "on-image captions"],
      "image": {
        "path": "images/shot-003a.png",
        "sha256": null,
        "status": "pending"
      },
      "semanticReview": {
        "status": "pending",
        "reviewedImageSha256": null,
        "notes": ""
      }
    }
  ],
  "release": {
    "productionQAPassed": false,
    "creativeApproval": null,
    "publishAuthorization": null
  }
}
```

The strings marked `PLACEHOLDER` are not valid actual SHA-256 values and are included **solely** to illustrate the target shape.

## Validation rules

1. Schema/version, stable IDs, safe local paths, file contents and SHA values validate.
2. All narration beats link to a precise text span in the approved script revision; `beats[].spokenText` must agree with the authoritative spoken script after a documented normalization policy.
3. Every final shot has one or more legitimate linked beats and a required visual event. The visual intent must include a perceivable story action or a documented purposeful establishing/transition shot.
4. Ordered shot timestamps are positive, within the verified audio duration and have no unexplained overlap/gaps. Exact word/segment alignment is required; provisional timing blocks final approval.
5. Each scene image is a saved, signature-verified file, matches expected aspect/dimensions, has a SHA and is bound to the relevant prompt/reference/script hashes.
6. A visual review must have **actually inspected the image** and refer to that exact image SHA plus beat and reference bundle hashes. Prompt compliance cannot be inferred from text-only metadata. Record `pass`, `fail` or `unknown` and explain all failures.
7. A changed script, reference, image, voice/text, or timing dependency invalidates corresponding review approvals and derived renders.
8. A production-ready video must have no missing/unreviewed/unmatched shots, no orphan narrated events, complete captions and validated media output. Synthetic fixtures are allowed only in marked offline-test mode and never pass production acceptance.
9. Release metadata must separately distinguish creative approval, independent QA, provider permission and explicit publication authorization.
10. No unreviewed or unrelated image may be substituted to meet the stills/minute target.

## Planning density

Cinematic default **14–18 stills per narration minute**; reflective ~12/min; energetic ~21/min. These are heuristic *planning bands*, adjusted by narrative beats, dwell time, source audio and generation quota. No arbitrary minimum independent of story content. A new shot must add visual storytelling value.

## Revision scope

- Script changes invalidate affected beat map, prompts, narration, alignment, scene timings and corresponding reviews; record exactly what is retained.
- Character/prop reference updates invalidate matching image prompts, images and visual QA.
- Image re-generation invalidates only the affected shot's pixel review and derived render (plus adjacent transition checks).
- Voice/audio timing updates invalidate caption and scene timing acceptance even when visual pixels remain valid.

## Expected test cases

- Three-beat chest / crystal / shaking-room example passes with manually reviewed authentic pixel fixtures.
- Missing/crystal-color-changed/unrelated image, shifted shot sequence and unverified scene image are rejected.
- Mismatched script hash or stale reference hash invalidates approval.
- Absent alignment or incorrect end time blocks production acceptance.
- Interrupted generation resumes without repeated external charges or overwriting approved stills.
- FFmpeg renders accurately and FFprobe confirms codec, duration and timeline; sound/video creative review remains separately required.
