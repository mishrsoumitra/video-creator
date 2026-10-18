import { describe, expect, it } from 'vitest';
import { MediaError, ffmpegBinary, ffprobeBinary, runProcess } from './index';

const node = process.execPath;

describe('runProcess', () => {
  it('returns stdout and stderr of a successful run', async () => {
    const result = await runProcess(node, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err")',
    ]);
    expect(result.stdout.toString()).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('passes arguments without a shell, so metacharacters stay literal', async () => {
    const result = await runProcess(node, [
      '-e',
      'process.stdout.write(process.argv[1])',
      '$(echo hacked); rm -rf /',
    ]);
    expect(result.stdout.toString()).toBe('$(echo hacked); rm -rf /');
  });

  it('maps a non-zero exit to MediaError "failed" with the stderr tail', async () => {
    const error = await runProcess(node, [
      '-e',
      'console.error("boom: bad input"); process.exit(3)',
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaError);
    expect(error).toMatchObject({ code: 'failed', exitCode: 3 });
    expect((error as MediaError).stderrTail).toContain('boom: bad input');
  });

  it('maps a missing binary to "spawn_failed"', async () => {
    await expect(runProcess('/definitely/not/a/binary', [])).rejects.toMatchObject({
      code: 'spawn_failed',
    });
  });

  it('kills the process and reports "timeout"', async () => {
    const started = Date.now();
    await expect(
      runProcess(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('honours an AbortSignal, including one that is already aborted', async () => {
    const controller = new AbortController();
    const run = runProcess(node, ['-e', 'setTimeout(() => {}, 10000)'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    await expect(
      runProcess(node, ['-e', ''], { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('stops collecting when stdout exceeds the limit', async () => {
    await expect(
      runProcess(node, ['-e', 'process.stdout.write("x".repeat(100000))'], {
        maxStdoutBytes: 1000,
      }),
    ).rejects.toMatchObject({ code: 'output_too_large' });
  });

  it('streams stdout to a callback instead of buffering it', async () => {
    const chunks: Buffer[] = [];
    const result = await runProcess(node, ['-e', 'process.stdout.write("abc")'], {
      onStdout: (c) => chunks.push(c),
    });
    expect(Buffer.concat(chunks).toString()).toBe('abc');
    expect(result.stdout.length).toBe(0);
  });
});

describe('binary resolution', () => {
  it('prefers explicit paths, then VC_FFMPEG_PATH / VC_FFPROBE_PATH, then PATH', () => {
    expect(ffmpegBinary({ ffmpegPath: '/opt/ff/ffmpeg' })).toBe('/opt/ff/ffmpeg');
    const before = { ff: process.env.VC_FFMPEG_PATH, fp: process.env.VC_FFPROBE_PATH };
    process.env.VC_FFMPEG_PATH = '/env/ffmpeg';
    process.env.VC_FFPROBE_PATH = '/env/ffprobe';
    try {
      expect(ffmpegBinary()).toBe('/env/ffmpeg');
      expect(ffprobeBinary()).toBe('/env/ffprobe');
    } finally {
      if (before.ff === undefined) delete process.env.VC_FFMPEG_PATH;
      else process.env.VC_FFMPEG_PATH = before.ff;
      if (before.fp === undefined) delete process.env.VC_FFPROBE_PATH;
      else process.env.VC_FFPROBE_PATH = before.fp;
    }
    expect(ffmpegBinary()).toBe(before.ff ?? 'ffmpeg');
  });
});
