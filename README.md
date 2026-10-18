# Video Creator

Topic in, narrated video out: research → script → voice → word timing → scenes → images →
captions → Remotion render → ffmpeg mix and mux → credits → final checks. It runs on your own
machine, with your own AI keys, and uses AI only where nothing deterministic will do.

Everything about the look is **one typed config object** (a Zod schema in `@vc/config`). The same
schema validates API requests, drives the web form, and is the Remotion composition's props schema,
so Remotion Studio gets a props editor for free.

## Requirements

- Node.js 22.12+ (developed on 24.14)
- ffmpeg and ffprobe on `PATH` (or `VC_FFMPEG_PATH` / `VC_FFPROBE_PATH`)
- Remotion downloads its own headless Chrome on first render
- Optional, for local models: `git`, `make` and `cmake` (whisper.cpp builds from source); disk space for
  Kokoro-82M (downloaded on first use)

## Quick start

```sh
npm install
npm run dev            # API on 127.0.0.1:4317, UI on http://localhost:5173
```

Production:

```sh
npm run build          # web UI, Remotion bundle, server bundle
npm start              # http://127.0.0.1:4317
```

On first run the app asks you to set up AI providers. Pick a provider per role, paste keys, and press
**Test** on each; nothing starts until every required role passes. Keys go to the OS keychain
(macOS Keychain, Windows Credential Manager, libsecret) or, without one, to a passphrase-encrypted file.
Every role can also run without a cloud key: Text on a local Ollama or LM Studio model, Voice on
Kokoro-82M or your own recording, Word timing on whisper.cpp, and Web search and Vision switched off.

Try the whole app without any keys:

```sh
npm run build && npm run demo   # http://127.0.0.1:4318: real ffmpeg and Remotion, fake AI (silent voice)
```

In Setup choose "Acme AI" for every role; the demo prints its test key in the terminal.

| Variable                            | Default            |                                                         |
| ----------------------------------- | ------------------ | ------------------------------------------------------- |
| `VC_PORT`                           | `4317`             | The server binds to 127.0.0.1 only                      |
| `VC_DATA_DIR`                       | `~/.video-creator` | SQLite database, jobs, caches, encrypted vault          |
| `VC_KEYCHAIN`                       | `1`                | `0` forces the encrypted-file vault                     |
| `VC_LOG_LEVEL`                      | `info`             | Logs are scrubbed of every stored key                   |
| `VC_WEB_DIST`, `VC_REMOTION_BUNDLE` | build outputs      | Override the served UI and the prebuilt Remotion bundle |

## Workspace

| Package                                    | What it is                                                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config` (`@vc/config`)           | The schema, field metadata, presets, simple-control bundles, speed derivation, timeline maths, caption grouping, warnings, render-time model, scene-plan and API contract                                               |
| `packages/pipeline` (`@vc/pipeline`)       | Role interfaces, AI-call ledger and cost cap, caches, every pipeline stage, orchestration. Never imports a vendor SDK                                                                                                   |
| `packages/providers` (`@vc/providers`)     | One file per provider (OpenAI, Anthropic, Gemini, ElevenLabs, Google TTS, Azure TTS, OpenAI-compatible/Ollama, Brave, SerpAPI, Kokoro, whisper.cpp), Openverse, SSRF-safe page and image fetchers, host-bound key guard |
| `packages/secrets` (`@vc/secrets`)         | Keychain / encrypted-file vault, key masking, log scrubbing                                                                                                                                                             |
| `packages/media` (`@vc/media`)             | ffmpeg: mix, sidechain ducking, two-pass loudnorm, clipping, mux, concat, contact sheets, library music                                                                                                                 |
| `packages/composition` (`@vc/composition`) | The Remotion composition and Studio root                                                                                                                                                                                |
| `apps/server` (`@vc/server`)               | Fastify API, SQLite store, setup gating, job and render queues                                                                                                                                                          |
| `apps/web` (`@vc/web`)                     | React UI: setup, create (simple / presets / advanced), review with `@remotion/player`, jobs, settings                                                                                                                   |

`docs/ARCHITECTURE.md` lists the Remotion 4.0.536 facts the code relies on (read from the installed
packages) and the invariants (timing, AI usage, security).

## Testing

```sh
npm test               # unit + web (fast; no network, no ffmpeg needed)
npm run test:media     # real ffmpeg: ducking depth, loudness, clipping, mux, concat
npm run test:render    # real Remotion renders and a full end-to-end job (minutes)
npm run test:all       # everything
npm run test:coverage
npm run verify         # typecheck + lint + all tests
```

Tests were written first and cover the spec's edge cases. Some of them:

- Schema and codec tables are cross-checked against the installed `@remotion/renderer` and `@remotion/transitions`.
- Speed never moves a scene boundary, at any speed or fps.
- The spring speed scaling is an exact time compression of Remotion's own `spring()`.
- An over-budget script is sent back once, then truncated at a sentence boundary.
- The model can't invent facts: every fact needs a verifiable quote.
- The image threshold is re-derived from a 50-scene labelled set.
- A style-only rerun makes zero AI calls.
- Keys never appear in the database, responses or logs.
- Every shader transition renders, and caption overflow is detected from a real render.
- A cancelled render goes back to review; after a restart, unfinished preparations fail with a clear
  message and interrupted renders return to review.
- A partial settings update never resets the settings it did not send.
- The last word of a sentence never sits alone on a caption page, unless a real pause comes first.

## How the spec maps to the code

| Spec                                                                                    | Where                                                                                      | Tests                                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| One schema: validates API, drives form, Studio props editor                             | `config/src/schema.ts`, `config/src/fields.ts`, `composition/src/Root.tsx`                 | `schema.test.ts`, `fields.test.ts`, `codecs.test.ts`                          |
| Five simple pickers → bundles; presets; Advanced; Output & Expert behind one more click | `config/src/bundles.ts`, `presets.ts`, `expert.ts`, `apps/web`                             | `bundles.test.ts`, `presets.test.ts`, `expert.test.ts`, web tests             |
| Speed 0.5–2× scales motion only, never narration timing                                 | `config/src/derive.ts`, `timeline.ts`                                                      | `derive.test.ts`, `timeline.test.ts`                                          |
| Transitions (20), timing, directions; shader-heavy ones gated until timed               | `config/src/transitions.ts`, `composition/src/presentations.ts`, `server/src/calibrate.ts` | `transitions.test.ts`, `render.render.test.ts`, `calibrate.render.test.ts`    |
| CRF ranges per codec; HW acceleration vs CRF                                            | `config/src/codecs.ts`, `schema.ts`, `fields.ts`                                           | `codecs.test.ts`, `fields.test.ts`                                            |
| Warn, don't block; curated presets                                                      | `config/src/warnings.ts`                                                                   | `warnings.test.ts`, `presets.test.ts`                                         |
| Render-time estimate measured from real renders                                         | `config/src/render-estimate.ts`, `server/src/jobs.ts`, `server/src/calibrate.ts`           | `render-estimate.test.ts`, `api.jobs.test.ts`, `calibrate.render.test.ts`     |
| Provider setup, test calls, one key many slots, local/off options                       | `server/src/setup.ts`                                                                      | `api.setup.test.ts`                                                           |
| Keys: keychain/encrypted file, last four only, never logged, host-bound                 | `secrets`, `providers/src/guard.ts`, `server/src/app.ts`                                   | `api.setup.test.ts`, `api.vault.test.ts`, `api.jobs.test.ts`, `guard.test.ts` |
| AI only where needed; every call logged with stage and reason                           | `pipeline/src/ledger.ts` and each stage                                                    | stage tests, `orchestrator.test.ts`                                           |
| Cost estimate before Generate, real cost after, per-job cap                             | `pipeline/src/cost-estimate.ts`, `ledger.ts`                                               | `cost-estimate.test.ts`, `ledger.test.ts`, `api.jobs.test.ts`                 |
| Caching: fact sheet a week, audio by script, images by query                            | `pipeline/src/cache.ts`, stages                                                            | `research.test.ts`, `voice.test.ts`, `images.test.ts`                         |
| Final checks, credits, .srt always written                                              | `pipeline/src/checks.ts`, `credits.ts`, `orchestrator.ts`                                  | `checks.test.ts`, `credits.test.ts`, `e2e.render.test.ts`                     |

## Useful commands

```sh
npm run demo              # the real app with fake AI providers (no keys, no cost)
npm run calibrate         # time calibration renders on this machine (same as the Settings button)
npm run studio            # Remotion Studio with the demo plan (props editor from the Zod schema)
npm run tune:threshold    # re-derive the image-score threshold from the labelled scenes
npx tsx packages/composition/scripts/render-stills.ts   # stills of every preset
```

Render-time estimates come from measured renders. Every finished render feeds the model; for a
head start, run `npm run calibrate` or use **Settings → Calibrate render estimates**. Calibration
also times the shader transitions (crosswarp, ripple, film-burn, book-flip) that are only offered
once they have been rendered on this machine.

## Notes

- Remotion is source-available: individuals and small companies use it free; larger teams need a
  company licence. See remotion.dev/license.
- Each provider price records its source and the date it was checked. A few (Google Chirp 3 HD,
  Azure neural voices, Brave, SerpAPI) come from third-party price lists because the official pages
  could not be read automatically: confirm them, and override any price in Settings. Estimates are
  estimates; the job page shows the real cost of every call.
- After changing `packages/config` or `packages/composition`, rebuild (`npm run build`): the server
  renders from the prebuilt Remotion bundle when one exists.
- `.github/workflows/ci.yml` runs the same gates on Ubuntu; it has not been run yet (no remote).
- Library music is generated on this machine with ffmpeg, so it carries no third-party licence.
