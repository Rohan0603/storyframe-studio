import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function assertSafeRelativePath(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
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
  const existing = await realpath(candidate).catch(() => candidate);
  const rel = relative(rootReal, existing);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`path escapes episode root: ${relativePath}`);
  return candidate;
}
