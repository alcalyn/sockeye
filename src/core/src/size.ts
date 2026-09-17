/**
 * Best-effort byte size of a message payload.
 *
 * Strings and binary payloads are measured exactly. Anything else is measured through
 * `JSON.stringify`, which is what socket.io puts on the wire anyway. Values that cannot
 * be serialized (circular structures, BigInt) count as 0 rather than throwing.
 */
export function measureSize(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;

  switch (typeof payload) {
    case 'string':
      return Buffer.byteLength(payload, 'utf8');
    case 'number':
    case 'boolean':
      return String(payload).length;
    case 'function':
      return 0;
  }

  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  if (payload instanceof ArrayBuffer) return payload.byteLength;

  try {
    const json = JSON.stringify(payload);
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  } catch {
    return 0;
  }
}

/** Total size of an argument list, ignoring a trailing acknowledgement callback. */
export function measureArgs(args: readonly unknown[]): number {
  let total = 0;
  for (const arg of args) {
    if (typeof arg === 'function') continue;
    total += measureSize(arg);
  }
  return total;
}

/** Default number of characters kept when a payload is captured for the top lists. */
export const DEFAULT_SAMPLE_CHARS = 1024;

/** Human-readable stand-in for a payload that is not text. */
function describeOpaque(payload: unknown): string {
  if (ArrayBuffer.isView(payload)) return `<binary ${payload.byteLength} bytes>`;
  if (payload instanceof ArrayBuffer) return `<binary ${payload.byteLength} bytes>`;
  return '<unserializable>';
}

/** Size of one payload, together with the text it was measured from. */
function serialize(payload: unknown): { bytes: number; text: string } {
  if (payload === undefined || payload === null) return { bytes: 0, text: String(payload) };

  switch (typeof payload) {
    case 'string':
      return { bytes: Buffer.byteLength(payload, 'utf8'), text: payload };
    case 'number':
    case 'boolean':
      return { bytes: String(payload).length, text: String(payload) };
    case 'function':
      return { bytes: 0, text: '' };
  }

  if (ArrayBuffer.isView(payload) || payload instanceof ArrayBuffer) {
    return { bytes: measureSize(payload), text: describeOpaque(payload) };
  }

  try {
    const json = JSON.stringify(payload);
    if (json === undefined) return { bytes: 0, text: '' };
    return { bytes: Buffer.byteLength(json, 'utf8'), text: json };
  } catch {
    return { bytes: 0, text: describeOpaque(payload) };
  }
}

/**
 * Measure an argument list and, in the same pass, keep a truncated copy of it.
 *
 * Seeing a 400 kB message in the "heaviest payloads" list only helps if you can tell what
 * was inside, so the top lists keep a preview. Serializing twice would be wasteful, hence
 * the single pass.
 */
export function describeArgs(
  args: readonly unknown[],
  maxChars = DEFAULT_SAMPLE_CHARS,
): { bytes: number; sample: string } {
  let bytes = 0;
  let sample = '';

  for (const arg of args) {
    if (typeof arg === 'function') continue;
    const part = serialize(arg);
    bytes += part.bytes;

    if (maxChars > 0 && sample.length < maxChars) {
      sample = sample.length === 0 ? part.text : `${sample} ${part.text}`;
    }
  }

  if (sample.length > maxChars) sample = `${sample.slice(0, maxChars)}…`;
  return { bytes, sample };
}
