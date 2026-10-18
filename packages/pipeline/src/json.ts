/** Pulls one JSON object out of a model reply (tolerates code fences and prose around it). */
export const extractJsonObject = (reply: string): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  const body = (fenced ? fenced[1]! : reply).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new SyntaxError('The reply contains no JSON object.');
  return JSON.parse(body.slice(start, end + 1));
};

export const tryExtractJsonObject = (
  reply: string,
): { ok: true; value: unknown } | { ok: false; error: string } => {
  try {
    return { ok: true, value: extractJsonObject(reply) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
