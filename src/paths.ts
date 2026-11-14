import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function assertSafeRelativePath(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\r') ||
    value.includes('\n') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    value.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(
      `${label} must be a safe path relative to the episode root`,
    );
  }
}

export async function resolveContained(
  root: string,
  relativePath: string,
): Promise<string> {
  assertSafeRelativePath(relativePath, 'path');
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, ...relativePath.split('/'));
  let existing = candidate;
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  const rel = relative(rootReal, existing);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`path escapes episode root: ${relativePath}`);
  return candidate;
}
