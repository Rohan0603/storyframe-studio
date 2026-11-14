const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isStableId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 80 && ID_PATTERN.test(value)
  );
}

export function assertStableId(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isStableId(value))
    throw new Error(`${label} must be a stable ID (lowercase kebab-case)`);
}
