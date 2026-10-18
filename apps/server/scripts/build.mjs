// Bundles the server into dist/index.js. Workspace packages (@vc/*, TypeScript source) are bundled;
// third-party packages stay external and load from node_modules at runtime.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/index.js', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  banner: {
    js: "import { createRequire as __vcCreateRequire } from 'node:module'; const require = __vcCreateRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'externalize-third-party',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@vc/') ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
  logLevel: 'info',
});
