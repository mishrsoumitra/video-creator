import type { FieldError } from '@vc/config';

/** An error with an HTTP status and a stable code, rendered as { error: { code, message, fields } }. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[] | undefined;
  constructor(status: number, code: string, message: string, fields?: FieldError[]) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found.`);

export const badRequest = (message: string, fields?: FieldError[]) =>
  new HttpError(400, 'invalid_request', message, fields);

export const prefixFields = (prefix: string, fields: readonly FieldError[]): FieldError[] =>
  fields.map((f) => ({ ...f, path: f.path ? `${prefix}.${f.path}` : prefix }));
