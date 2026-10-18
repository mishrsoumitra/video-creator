/**
 * Renders a few stills of every built-in preset with the demo plan, for a quick visual check.
 *   npx tsx packages/composition/scripts/render-stills.ts [outDir]
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { BUILT_IN_PRESETS } from '@vc/config';
import { COMPOSITION_ID } from '../src/metadata';

const root = new URL('..', import.meta.url).pathname;
const out = process.argv[2] ?? join(root, 'out', 'stills');
await mkdir(out, { recursive: true });
const serveUrl = await bundle({
  entryPoint: join(root, 'src/entry.ts'),
  publicDir: join(root, 'public'),
});
for (const preset of BUILT_IN_PRESETS) {
  const inputProps = { config: preset.config };
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });
  for (const frame of [50, 130, 200]) {
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      frame,
      output: join(out, `${preset.id}-${frame}.png`),
      scale: 0.5,
      logLevel: 'error',
    });
  }
  console.log(`rendered ${preset.id}`);
}
