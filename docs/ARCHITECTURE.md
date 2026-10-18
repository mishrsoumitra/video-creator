# Architecture

Topic → researched, narrated, captioned video. Everything about the look is **one typed
config object** (`VideoConfig`, a Zod schema in `@vc/config`). The same schema validates API
requests, drives the web form, and is the Remotion composition's props schema (so Remotion
Studio gets a props editor for free via `@remotion/zod-types`).

## Workspaces

| Package           | Role                                                                                                                                                                  | May import                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@vc/config`      | Schema, field metadata, presets, simple-control bundles, speed derivation, timeline math, caption grouping, warnings, render-time & cost estimators, ScenePlan schema | zod, `@remotion/zod-types`, `@remotion/captions`                                       |
| `@vc/secrets`     | Key vault (OS keychain via `@napi-rs/keyring`, else AES-256-GCM file unlocked by passphrase), masking, log scrubbing                                                  | node built-ins                                                                         |
| `@vc/media`       | ffmpeg/ffprobe: probe, mix + sidechain ducking, two-pass loudnorm, clipping, mux, concat, contact sheet, image stats                                                  | node built-ins                                                                         |
| `@vc/pipeline`    | Role interfaces, `aiCall` wrapper + reasons ledger, cost cap, cache interface, every stage, orchestrator                                                              | `@vc/config`, zod. **Never vendor SDKs, never `@vc/providers`** (lint + test enforced) |
| `@vc/providers`   | One file per provider adapter implementing a role interface; registry; host-bound key fetch guard                                                                     | `@vc/pipeline` (types), `@vc/media`                                                    |
| `@vc/composition` | Remotion composition (responsive), Root with schema for Studio                                                                                                        | `@vc/config`, `remotion`, `@remotion/*`                                                |
| `@vc/server`      | Fastify API on 127.0.0.1, SQLite store, render queue, setup gating                                                                                                    | all of the above                                                                       |
| `@vc/web`         | React UI: Setup, Create (simple / presets / advanced), Review (`@remotion/player`), Job, Settings                                                                     | `@vc/config`, `@vc/composition`                                                        |

Internal packages export TypeScript source (`exports` → `src/*.ts`); Vite, Vitest, tsx and
Remotion's bundler compile them. Server production build bundles with esbuild.

## Facts read from installed Remotion 4.0.536 (not from memory)

- Transitions (`@remotion/transitions` subpath exports): fade, slide, wipe, flip, clock-wipe,
  iris, none, push-cut (CSS) and dissolve, zoom-in-out, cross-zoom, zoom-blur, linear-blur,
  blur-slide, dreamy-zoom, book-flip, crosswarp, ripple, film-burn, swap (**WebGL shaders via
  HTML-in-canvas**; they throw when `HtmlInCanvas.isSupported()` is false). The renderer always
  launches Chrome with `--enable-features=...CanvasDrawElement`, so final renders support them;
  an ordinary browser usually does not → the Player preview substitutes a CSS stand-in.
- Directions: slide/flip/book-flip/blur-slide take `from-left|from-right|from-top|from-bottom`;
  wipe also takes the four diagonals. clock-wipe and iris need `width`/`height`.
- `TransitionSeries.Sequence` must not be shorter than an adjacent transition.
  `TransitionSeries.Overlay` exists (used for light leaks at cuts).
- spring defaults: mass 1, damping 10, stiffness 100, overshootClamping false; damping ≤ 0 throws.
- Easing: linear, ease, quad, cubic, sin, exp, circle, back(s), bounce, elastic(b),
  bezier(x1,y1,x2,y2) — bezier throws if an x value is outside [0, 1]; in/out/inOut wrappers.
- CRF ranges/defaults (`@remotion/renderer` crf.js): h264 [1,51] 18 (CRF 0 rejected), h265
  [0,51] 23, vp8 [4,63] 9, vp9 [0,63] 28, av1 [0,63] 30, prores none (profile instead).
  Explicit CRF + hardware acceleration throws. HW accel: h264/h265 (VideoToolbox on macOS,
  NVENC elsewhere), prores (macOS only); vp8/vp9/av1 never.
- Pixel formats: yuv420p (default), yuva420p (vp8/vp9 only), yuv422p, yuv444p, yuv420p10le,
  yuv422p10le, yuv444p10le, yuva444p10le; transparent formats need PNG frames.
  x264 presets ultrafast…placebo (h264 only). Color spaces: default, bt601, bt709, bt2020-ncl.
  ProRes profiles: 4444-xq, 4444, hq, standard, light, proxy. jpegQuality 0–100 (default 80).
  concurrency: integer 1…cores or `"NN%"`. scale > 0.
- `@remotion/effects` effects apply through `<Solid effects>` / `<Img effects>` on 2D/WebGL2
  canvases (no HTML-in-canvas needed): linearGradient, tint, rings, gridlines, checkerboard,
  zigzag, tile, noise, vignette, light-leak, starburst …
- `<LightLeak seed hueShift>`, `<Starburst rays colors …>` have no intensity prop → opacity.
- `CameraMotionBlur` shutterAngle 180, samples 10 (integer ≥ 0).
- `@remotion/captions`: `createTikTokStyleCaptions({captions, combineTokensWithinMilliseconds,
breakOnSilenceAfterMilliseconds?})`, `serializeSrt`, `Caption {text,startMs,endMs,timestampMs,confidence}`.
- `@remotion/layout-utils`: fitText, fitTextOnNLines, fillTextBox, measureText (DOM only → runs
  inside the composition; overflow is reported through `console.log` → `onBrowserLog`).
- `@remotion/google-fonts`: `getAvailableFonts()`, per-font `loadFont`, and
  `@remotion/google-fonts/from-info` `loadFontFromInfo` (used so bundles don't include 1,800 fonts).
- `@remotion/openai-whisper` `openAiWhisperApiToCaptions`; `@remotion/install-whisper-cpp`
  `installWhisperCpp`, `downloadWhisperModel`, `transcribe`, `toCaptions`.
- Core `Audio` === `Html5Audio` (used for preview only; final audio is mixed by ffmpeg).

## Timing invariants

- The timing stage writes scene boundaries in **milliseconds** from the voice. Frames are derived
  in the composition from `fps`, so changing fps in review needs no server round-trip.
- Animation speed (0.5–2×) scales: transition length (÷s), caption spring (stiffness ×s²,
  damping ×s — an exact time compression), zoom per second (×s), start-of-scene hold (÷s).
  It never moves a scene boundary or changes the total duration.
- Transitions are centred on the cut: outgoing sequence ends `floor(T/2)` after the cut, incoming
  starts `T - floor(T/2)` before it; `T ≤ min(adjacent scene lengths)`. Σ sequences − Σ T =
  narration frames for every speed.

## AI usage rule

Every stage tries the deterministic path first. All AI goes through `aiCall()`, which records
stage, role, provider, model, **reason**, units and cost, enforces the per-job cost cap
(required calls fail the job, optional ones are skipped and logged) and a max-call guard.

## Security

- Keys live only in the vault; SQLite stores provider ids and last four characters.
- Adapters receive a guarded `fetch` that refuses to send any request containing the key to a
  host outside the provider's allowlist. Page fetches for research carry no credentials and
  block private/loopback addresses (SSRF).
- Logs pass through a scrubber that removes registered secret values; header names are redacted.
- Server binds 127.0.0.1, rejects foreign `Host` (DNS rebinding) and cross-origin mutations
  (requires `x-vc-client` header + matching `Origin`).

## Job lifecycle

```
POST /api/jobs ──► queued ──► preparing ──► review ──► (POST /render) rendering ──► done
                                 │                         │                       │
                                 └──► failed / cancelled ◄─┘   style-only rerender ┘ (no AI)
```

- **Preparing** (concurrency 2): research → script → voice → timing → images → captions. Produces a
  `ScenePlan` with relative asset URLs; every provider call is persisted with stage and reason.
- **Review**: the browser plays the plan with `@remotion/player` using the same composition; style
  changes re-render locally with no server round trip.
- **Rendering** (render queue, concurrency 1): Remotion renders muted video with absolute asset
  URLs; ffmpeg mixes narration and music (sidechain ducking, two-pass loudnorm) and muxes; credits
  and `.srt` are written; final checks run. Each render is a sample for the render-time model and
  marks the transitions it used as timed.
- Cancelling a render returns the job to review with its plan intact; a failed render can be retried.
- On restart, queued and preparing jobs fail with a clear message and interrupted renders return to
  review.
- In review, `POST /api/jobs/:id/estimate` prices a style against the job's real length and scene
  count; after each render the job's estimate is recomputed with that render's measurement.

## Testing tiers

| Tier   | Command               | What it proves                                                                                                                     |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| unit   | `npm test`            | Schema, bundles, timing invariants, every pipeline stage with fakes, providers with injected fetch, server API with injected seams |
| web    | `npm test`            | The three UI layers, setup gating, key handling, review preview, through Testing Library                                           |
| media  | `npm run test:media`  | Real ffmpeg: ducking depth, loudness, clipping, mux, concat, contact sheets                                                        |
| render | `npm run test:render` | Real Remotion renders (all transitions, backdrops, aspects, caption overflow), calibration, and a full API → video job             |

`npm run demo` runs the real app with fake AI providers (no keys, real rendering) for manual checks.
