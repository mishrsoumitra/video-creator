import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { MediaError } from './errors';

/** Options every media function accepts. */
export type MediaOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
};

export const ffmpegBinary = (options: MediaOptions = {}): string =>
  options.ffmpegPath ?? process.env.VC_FFMPEG_PATH ?? 'ffmpeg';
export const ffprobeBinary = (options: MediaOptions = {}): string =>
  options.ffprobePath ?? process.env.VC_FFPROBE_PATH ?? 'ffprobe';

export type RunOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Fail with output_too_large when buffered stdout grows past this. */
  maxStdoutBytes?: number;
  /** Stream stdout here instead of buffering it (for large raw PCM). */
  onStdout?: (chunk: Buffer) => void;
};

export type RunResult = { stdout: Buffer; stderr: string };

/** Stderr kept for parsing (loudnorm prints its JSON at the very end) and for error messages. */
const STDERR_KEEP = 256 * 1024;
const TAIL_LINES = 20;

const tail = (stderr: string) => stderr.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');

/**
 * Runs a binary with an argument array (never a shell), with timeout and AbortSignal support.
 * Non-zero exits become MediaError('failed') carrying the stderr tail.
 */
export const runProcess = (
  binary: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> =>
  new Promise<RunResult>((resolve, reject) => {
    const command = `${basename(binary)} ${args.join(' ')}`;
    if (options.signal?.aborted) {
      reject(
        new MediaError({
          code: 'aborted',
          message: `${basename(binary)} was aborted before it started.`,
          command,
        }),
      );
      return;
    }
    const child = spawn(binary, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;

    const finish = (error: MediaError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        reject(error);
      } else {
        resolve({ stdout: Buffer.concat(stdout), stderr });
      }
    };

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () =>
              finish(
                new MediaError({
                  code: 'timeout',
                  message: `${basename(binary)} timed out after ${options.timeoutMs} ms.`,
                  stderrTail: tail(stderr),
                  command,
                }),
              ),
            options.timeoutMs,
          );

    const onAbort = () =>
      finish(
        new MediaError({
          code: 'aborted',
          message: `${basename(binary)} was aborted.`,
          stderrTail: tail(stderr),
          command,
        }),
      );
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (options.onStdout) {
        options.onStdout(chunk);
        return;
      }
      stdoutBytes += chunk.length;
      if (options.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
        finish(
          new MediaError({
            code: 'output_too_large',
            message: `${basename(binary)} wrote more than ${options.maxStdoutBytes} bytes.`,
            command,
          }),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(
        new MediaError({
          code: 'spawn_failed',
          message:
            error.code === 'ENOENT'
              ? `${binary} was not found. Install ffmpeg or set VC_FFMPEG_PATH.`
              : `Could not start ${binary}: ${error.message}`,
          command,
          cause: error,
        }),
      ),
    );
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(null);
        return;
      }
      finish(
        new MediaError({
          code: 'failed',
          message: `${basename(binary)} exited with ${code === null ? `signal ${signal}` : `code ${code}`}: ${tail(stderr).split('\n').at(-1) ?? ''}`,
          exitCode: code,
          stderrTail: tail(stderr),
          command,
        }),
      );
    });
  });

/** ffmpeg with -hide_banner -nostdin and a quiet log level unless the caller overrides it. */
export const runFfmpeg = (
  args: readonly string[],
  options: MediaOptions & Omit<RunOptions, 'signal' | 'timeoutMs'>,
): Promise<RunResult> => {
  const loglevel = args.includes('-loglevel') ? [] : ['-loglevel', 'error'];
  return runProcess(
    ffmpegBinary(options),
    ['-hide_banner', '-nostdin', ...loglevel, ...args],
    options,
  );
};

export const runFfprobe = (args: readonly string[], options: MediaOptions): Promise<RunResult> =>
  runProcess(ffprobeBinary(options), ['-hide_banner', '-loglevel', 'error', ...args], options);
