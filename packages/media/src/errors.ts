export type MediaErrorCode =
  | 'spawn_failed'
  | 'failed'
  | 'timeout'
  | 'aborted'
  | 'not_found'
  | 'invalid_input'
  | 'parse_failed'
  | 'output_too_large';

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly exitCode: number | null;
  /** The last lines ffmpeg/ffprobe wrote to stderr, for diagnosis. */
  readonly stderrTail: string;
  readonly command: string;

  constructor(init: {
    code: MediaErrorCode;
    message: string;
    exitCode?: number | null;
    stderrTail?: string;
    command?: string;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'MediaError';
    this.code = init.code;
    this.exitCode = init.exitCode ?? null;
    this.stderrTail = init.stderrTail ?? '';
    this.command = init.command ?? '';
  }
}
