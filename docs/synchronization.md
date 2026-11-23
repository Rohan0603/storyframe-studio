# Audio-locked synchronization

Issue #23 adds an optional `syncTimeline` to the canonical `episode.json`.
It is the only authoritative binding between verified narration, stills and
subtitle cues. The timeline is accepted only when its audio/script hashes,
shot order, exact beat spans, image source identity, image SHA, pixel review,
subtitle text and cue timestamps all agree with the episode.

Run `storyframe sync-review <episode-root>` after writing or retiming the
timeline. It writes the read-only projections `output/timeline-review.csv` and
`output/timeline-review.html`. The HTML storyboard is evidence for human
actual-pixel inspection; prompts and filenames do not constitute approval.

For an existing v1 episode, the command still produces a projection but labels
it `legacy-unverified`. Do not set `syncTimeline.status` to `verified` until
the selected narration audio has a durable SHA and measured duration, the
approved script spans have been mapped to the actual audio, every image has
been inspected against its spoken event, and every subtitle cue is hash-bound
and checked. The migration is deliberately opt-in so old projects remain
readable and are never silently upgraded.

The migration order is:

1. Verify the approved script and create exact `beats[]` spans.
2. Verify the selected Kokoro (or explicitly authorized provider) audio and
   alignment; record `audioSha256`, `audioDurationMs`, and `alignmentPath`.
3. Retimes shots from measured audio boundaries and add one `syncTimeline`
   record per shot. Use a distinct record for each meaningful subspan or an
   explicit intentional hold.
4. Bind the exact prompt, image path/SHA, source shot ID and pixel-review
   evidence. Reject swapped files or stale reference bindings.
5. Add verified subtitle cues from the same records, run `sync-review`, inspect
   the HTML storyboard with the audio, then render. Captions and FFmpeg shot
   durations must come from the same validated timeline.

This issue does not generate new narration or images, spend provider quota,
publish videos, or claim that a private Episode 2 MP4 is repaired. Episode 2
can be re-exported only when its local audio, image and review evidence are
available and inspected.
