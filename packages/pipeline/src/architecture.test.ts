import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('.', import.meta.url).pathname;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

const importsOf = (code: string): string[] =>
  [...code.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map(
    (m) => m[1]!,
  );

const VENDOR_SDK =
  /^(openai|@anthropic-ai\/|@google\/genai|@google\/generative-ai|@google-cloud\/|elevenlabs|@elevenlabs\/|microsoft-cognitiveservices-speech-sdk|ai$|@ai-sdk\/|kokoro-js)/;

describe('architecture: the pipeline never imports a vendor SDK directly', () => {
  const files = sourceFiles(root);

  it('scans the whole package', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [relative(root, f), f] as const))(
    '%s imports no vendor SDK and no provider adapter',
    (_name, file) => {
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        expect(specifier).not.toMatch(VENDOR_SDK);
        expect(specifier).not.toMatch(/^@vc\/(providers|server|web|secrets)/);
      }
    },
  );

  it('only depends on the config package, zod and node built-ins at runtime', () => {
    const external = new Set(
      files
        .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes('/testing/'))
        .flatMap((f) => importsOf(readFileSync(f, 'utf8')))
        .filter((s) => !s.startsWith('.') && !s.startsWith('node:')),
    );
    expect([...external].sort()).toEqual(['@vc/config', 'zod']);
  });
});
