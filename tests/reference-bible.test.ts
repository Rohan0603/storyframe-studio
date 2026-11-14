import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  freezeReferenceBible,
  validateReferenceBible,
} from '../src/reference-bible.js';
import type { ReferenceBible } from '../src/types.js';

const hash = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'storyframe-bible-'));
  await mkdir(join(root, 'references'));
  await writeFile(join(root, 'references', 'traveler.png'), png);
  const bible: ReferenceBible = {
    bundleId: 'bible-01',
    storyRevisionId: 'script-revision-01',
    storyRevisionSha256: 'a'.repeat(64),
    canonSha256: 'b'.repeat(64),
    entries: [
      {
        id: 'traveler',
        kind: 'character',
        name: 'Traveler',
        visualCanon: 'Short dark hair, amber coat, consistent proportions.',
        canonEntityId: 'traveler',
        image: {
          path: 'references/traveler.png',
          sha256: hash(png),
          mimeType: 'image/png',
          approved: true,
        },
      },
    ],
  };
  return { root, bible };
}

describe('frozen reference bible', () => {
  it('verifies actual image bytes and produces a deterministic freeze hash', async () => {
    const { root, bible } = await fixture();
    const result = await validateReferenceBible(root, bible, {
      storyRevisionId: 'script-revision-01',
      storyRevisionSha256: 'a'.repeat(64),
      canonSha256: 'b'.repeat(64),
    });
    expect(result.valid).toBe(true);
    expect(result.freezeSha256).toBe(freezeReferenceBible(bible));
  });

  it('rejects modified bytes and extension-only prompt substitutes', async () => {
    const { root, bible } = await fixture();
    await writeFile(
      join(root, 'references', 'traveler.png'),
      'a prompt, not pixels',
    );
    bible.entries[0]!.image.sha256 = hash('a prompt, not pixels');
    const result = await validateReferenceBible(root, bible);
    expect(result.errors.join('\n')).toMatch(/signature mismatch/);
  });

  it('rejects missing images, traversal, and symlinks escaping the root', async () => {
    const { root, bible } = await fixture();
    const missing = {
      ...bible,
      entries: bible.entries.map((entry) => ({
        ...entry,
        image: { ...entry.image, path: 'references/missing.png' },
      })),
    };
    let result = await validateReferenceBible(root, missing);
    expect(result.errors.join('\n')).toMatch(/unavailable|ENOENT/);
    bible.entries[0]!.image.path = '../outside.png';
    result = await validateReferenceBible(root, bible);
    expect(result.valid).toBe(false);
    const outside = await mkdtemp(join(tmpdir(), 'storyframe-outside-'));
    await writeFile(join(outside, 'traveler.png'), png);
    bible.entries[0]!.image.path = 'references/linked.png';
    await symlink(
      join(outside, 'traveler.png'),
      join(root, 'references', 'linked.png'),
    );
    result = await validateReferenceBible(root, bible);
    expect(result.errors.join('\n')).toMatch(/escapes|unsafe|unavailable/);
  });

  it('rejects textual revision or canon drift', async () => {
    const { root, bible } = await fixture();
    const result = await validateReferenceBible(root, bible, {
      storyRevisionId: 'script-revision-02',
      storyRevisionSha256: 'c'.repeat(64),
      canonSha256: 'd'.repeat(64),
    });
    expect(result.errors.join('\n')).toMatch(/stale/);
  });

  it('rejects unknown or wrong-kind textual canon bindings', async () => {
    const { root, bible } = await fixture();
    const result = await validateReferenceBible(root, bible, {
      canon: {
        characters: [],
        props: [{ id: 'traveler', name: 'Traveler', state: 'present' }],
        observations: [],
      },
    });
    expect(result.errors.join('\n')).toMatch(/incompatible|unknown/);
  });
});
