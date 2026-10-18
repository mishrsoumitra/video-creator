import { z } from 'zod';
import { LENGTH_PRESETS_SECONDS } from './enums';
import { VideoConfigSchema } from './schema';

export const WordTimingSchema = z.strictObject({
  text: z.string(),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  confidence: z.number().min(0).max(1).nullable().optional(),
});
export type WordTiming = z.output<typeof WordTimingSchema>;

export const CreditSchema = z.strictObject({
  title: z.string(),
  creator: z.string().nullable(),
  license: z.string(),
  licenseVersion: z.string().nullable(),
  licenseUrl: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  provider: z.string(),
});
export type Credit = z.output<typeof CreditSchema>;

const unit = z.number().min(0).max(1);
const Box = z.strictObject({ x: unit, y: unit, w: unit, h: unit });

export const ImageVisualSchema = z.strictObject({
  type: z.literal('image'),
  src: z.string().min(1),
  width: z.int().positive(),
  height: z.int().positive(),
  credit: CreditSchema.nullable().optional(),
  /** Where the subject is, as fractions of the image (deterministic saliency); used by follow-subject captions. */
  subject: Box.optional(),
});

export const TypographicVisualSchema = z.strictObject({
  type: z.literal('typographic'),
  text: z.string().trim().min(1).max(200),
});

export const PlanSceneSchema = z.strictObject({
  id: z.string().min(1),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  narration: z.string(),
  visual: z.discriminatedUnion('type', [ImageVisualSchema, TypographicVisualSchema]),
  /** Chosen per scene for "auto" and "follow subject" caption positions. */
  captionPlacement: z.enum(['top', 'middle', 'bottom']).default('bottom'),
});
export type PlanScene = z.output<typeof PlanSceneSchema>;

/** @remotion/google-fonts FontInfo; only the fields we read are checked, the rest pass through. */
export const FontInfoSchema = z.looseObject({ fontFamily: z.string(), importName: z.string() });
export type FontInfo = z.output<typeof FontInfoSchema>;

/** The composition's data props, produced by the pipeline. Times are in ms; frames are derived. */
export const ScenePlanSchema = z
  .strictObject({
    version: z.literal(1),
    title: z.string().max(200),
    durationMs: z.number().positive(),
    scenes: z.array(PlanSceneSchema).min(1),
    words: z.array(WordTimingSchema),
    audio: z.strictObject({
      narrationSrc: z.string().min(1),
      musicSrc: z.string().min(1).nullable(),
    }),
    palette: z.array(z.string()).length(5).nullable(),
    fonts: z.strictObject({ caption: FontInfoSchema.nullable() }),
  })
  .superRefine((plan, ctx) => {
    plan.scenes.forEach((scene, i) => {
      if (i === 0 && scene.startMs !== 0)
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', 0, 'startMs'],
          message: 'The first scene must start at 0.',
        });
      if (scene.endMs <= scene.startMs)
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', i, 'endMs'],
          message: 'Scenes need a positive duration.',
        });
      if (i > 0 && scene.startMs !== plan.scenes[i - 1]!.endMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', i, 'startMs'],
          message: 'Scenes must be contiguous.',
        });
      }
    });
    if (plan.scenes.at(-1)!.endMs > plan.durationMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationMs'],
        message: 'The narration ends before the last scene.',
      });
    }
  });
export type ScenePlan = z.output<typeof ScenePlanSchema>;

/** The composition's props: the style config plus the plan. Remotion Studio edits this schema. */
export const CompositionPropsSchema = z.strictObject({
  config: VideoConfigSchema,
  plan: ScenePlanSchema,
});
export type CompositionProps = z.output<typeof CompositionPropsSchema>;

export { LENGTH_PRESETS_SECONDS };

/** POST /api/jobs. Either a full config, or a preset id plus overrides (validated by resolveConfigInput). */
export const JobRequestSchema = z
  .strictObject({
    topic: z.string().trim().min(3, 'The topic needs at least 3 characters.').max(200),
    lengthSeconds: z.int().min(15).max(600),
    config: VideoConfigSchema.optional(),
    presetId: z.string().min(1).max(80).optional(),
    overrides: z.record(z.string(), z.unknown()).optional(),
    sourceText: z
      .string()
      .max(100_000)
      .optional()
      .transform((v) => (v === undefined || v.trim() === '' ? undefined : v)),
    recordingUploadId: z.string().min(1).max(100).optional(),
  })
  .superRefine((r, ctx) => {
    if ((r.config === undefined) === (r.presetId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message: 'Send either a config or a presetId.',
      });
    }
    if (r.overrides !== undefined && r.presetId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['overrides'],
        message: 'Overrides apply to a presetId.',
      });
    }
  });
export type JobRequest = z.output<typeof JobRequestSchema>;
