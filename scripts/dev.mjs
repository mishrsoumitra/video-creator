// Development: the API server (tsx watch, port 4317) and the Vite UI (port 5173, proxying /api).
import { spawn } from 'node:child_process';

const children = [
  spawn('npx', ['tsx', 'watch', 'apps/server/src/main.ts'], {
    stdio: 'inherit',
    env: { ...process.env, VC_DEV: '1' },
  }),
  spawn('npm', ['run', 'dev', '-w', '@vc/web'], { stdio: 'inherit', env: process.env }),
];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children)
  child.on('exit', (code) => code && process.exitCode === undefined && (process.exitCode = code));
