import { VideoConfigSchema, type VideoConfig, type VideoConfigInput } from './schema';

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export const deepFreeze = <T>(value: T): Readonly<T> => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]))
    );
  }
  return false;
};

/** Every field at its schema default. Frozen: copy it (mergeConfig/structuredClone) before editing. */
export const SCHEMA_DEFAULTS: Readonly<VideoConfig> = deepFreeze(VideoConfigSchema.parse({}));

/**
 * Objects at these paths are one value (a discriminated union), so a patch replaces them whole:
 * merging `{type: 'bezier', ...}` into `{type: 'ease', direction}` would leave a stray key.
 */
export const ATOMIC_PATHS: ReadonlySet<string> = new Set(['motion.easing']);

const mergeInto = (
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  prefix: string,
): void => {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const current = target[key];
    if (isPlainObject(value) && isPlainObject(current) && !ATOMIC_PATHS.has(path)) {
      mergeInto(current, value, path);
    } else {
      target[key] = structuredClone(value);
    }
  }
};

/**
 * Deep-merges a partial config onto a base: objects merge, arrays and scalars replace, `undefined`
 * leaves a value alone. Returns a fresh, mutable object. The result is not validated; parse it with
 * VideoConfigSchema when the patch comes from outside.
 */
export const mergeConfig = (
  base: VideoConfig | VideoConfigInput,
  patch: VideoConfigInput,
): VideoConfig => {
  const result = structuredClone(base) as Record<string, unknown>;
  mergeInto(result, patch as Record<string, unknown>, '');
  return result as VideoConfig;
};
