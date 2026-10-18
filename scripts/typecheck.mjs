// Type-checks every workspace with its own compiler options (DOM vs Node), in parallel.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const projects = [
  'packages/config',
  'packages/secrets',
  'packages/media',
  'packages/pipeline',
  'packages/providers',
  'packages/composition',
  'apps/server',
  'apps/web',
].filter((p) => existsSync(`${p}/tsconfig.json`));

const run = (project) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '-p', `${project}/tsconfig.json`, '--pretty'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ project, code, out }));
  });

const results = await Promise.all(projects.map(run));
let failed = 0;
for (const r of results) {
  if (r.code === 0) {
    console.log(`✓ ${r.project}`);
  } else {
    failed++;
    console.log(`✗ ${r.project}\n${r.out}`);
  }
}
process.exit(failed ? 1 : 0);
