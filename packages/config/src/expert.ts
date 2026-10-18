import type { z } from 'zod';
import { isPlainObject, mergeConfig } from './defaults';
import { BUILT_IN_PRESETS, type Preset } from './presets';
import { VideoConfigSchema, type VideoConfig, type VideoConfigInput } from './schema';

export type FieldError = { path: string; message: string; line?: number; column?: number };
export type ConfigResult = { ok: true; config: VideoConfig } | { ok: false; errors: FieldError[] };

export const formatZodIssues = (issues: readonly z.core.$ZodIssue[]): FieldError[] =>
  issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));

const locate = (message: string, text: string): { line: number; column: number } => {
  const lineCol = /line (\d+) column (\d+)/.exec(message);
  if (lineCol) return { line: Number(lineCol[1]), column: Number(lineCol[2]) };
  const position = /position (\d+)/.exec(message);
  const offset = position ? Number(position[1]) : text.length;
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

/** Expert mode: the raw JSON editor's text, validated against the schema before it is accepted. */
export const parseExpertJson = (text: string): ConfigResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errors: [{ path: '', message: `Invalid JSON: ${message}`, ...locate(message, text) }],
    };
  }
  if (!isPlainObject(raw))
    return { ok: false, errors: [{ path: '', message: 'The config must be a JSON object.' }] };
  const result = VideoConfigSchema.safeParse(raw);
  return result.success
    ? { ok: true, config: result.data }
    : { ok: false, errors: formatZodIssues(result.error.issues) };
};

/** Canonical JSON: schema key order, two-space indent. */
export const stringifyConfig = (config: VideoConfig | VideoConfigInput): string =>
  JSON.stringify(VideoConfigSchema.parse(config), null, 2);

/** API requests carry either a full config, or a preset id plus deep-merged overrides. */
export const resolveConfigInput = (
  input: { config?: unknown; presetId?: string; overrides?: unknown },
  userPresets: readonly Preset[],
): ConfigResult => {
  const hasConfig = input.config !== undefined;
  const hasPreset = input.presetId !== undefined;
  if (hasConfig && hasPreset)
    return {
      ok: false,
      errors: [{ path: '', message: 'Send either a config or a presetId, not both.' }],
    };
  if (!hasConfig && !hasPreset)
    return {
      ok: false,
      errors: [{ path: 'config', message: 'A config or a presetId is required.' }],
    };
  if (hasConfig) {
    const result = VideoConfigSchema.safeParse(input.config);
    return result.success
      ? { ok: true, config: result.data }
      : { ok: false, errors: formatZodIssues(result.error.issues) };
  }
  const preset = [...BUILT_IN_PRESETS, ...userPresets].find((p) => p.id === input.presetId);
  if (!preset)
    return {
      ok: false,
      errors: [{ path: 'presetId', message: `Unknown preset "${input.presetId}".` }],
    };
  if (input.overrides !== undefined && !isPlainObject(input.overrides)) {
    return { ok: false, errors: [{ path: 'overrides', message: 'Overrides must be an object.' }] };
  }
  const merged = mergeConfig(preset.config, {
    basedOnPreset: preset.id,
    ...((input.overrides ?? {}) as VideoConfigInput),
  });
  const result = VideoConfigSchema.safeParse(merged);
  return result.success
    ? { ok: true, config: result.data }
    : { ok: false, errors: formatZodIssues(result.error.issues) };
};
