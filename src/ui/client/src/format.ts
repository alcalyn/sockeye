const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];

export function bytes(value: number): string {
  if (!value) return '0 B';
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${UNITS[unit]}`;
}

export function ms(value: number | undefined | null): string {
  if (value === undefined || value === null) return '-';
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 1000) return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function count(value: number): string {
  return value.toLocaleString();
}

export function time(value: number | null): string {
  return value ? new Date(value).toLocaleTimeString() : '-';
}

/** Average throughput over the collection window, e.g. `12 kB/s`. */
export function rate(total: number, from: number | null, to: number | null): string {
  if (!from || !to || to <= from) return '-';
  return `${bytes(total / ((to - from) / 1000))}/s`;
}

/** Short description of the period a set of numbers covers. */
export function coverage(window: { from: number; to: number; resolutionMs: number } | null): string {
  if (!window) return 'everything since collection started';
  return `${new Date(window.from).toLocaleString()} → ${new Date(window.to).toLocaleString()} · every ${unit(window.resolutionMs)}`;
}

const PERIODS: [ms: number, name: string][] = [
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
  [1_000, 'second'],
];

/**
 * Name a length of time the way someone would say it: `minute`, `30 minutes`, `4 hours`.
 * Chart steps are never a round unit for long periods, so the number has to be said too.
 */
export function unit(resolutionMs: number): string {
  const [size, name] = PERIODS.find(([ms]) => resolutionMs >= ms) ?? [1, 'moment'];
  const amount = Math.round(resolutionMs / size);
  return amount === 1 ? name : `${amount} ${name}s`;
}

/**
 * Label a point in time at the right precision for the bucket size: a time of day for
 * minutes and hours, a date for days.
 */
export function clockFor(resolutionMs: number): (value: number) => string {
  return (value: number) => {
    const date = new Date(value);
    if (resolutionMs >= 86_400_000) {
      return date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
    }
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };
}

/** Pretty-print a captured payload when it happens to be JSON. */
export function payload(sample: string): string {
  const trimmed = sample.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return sample;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    // Truncated JSON is expected: show it as it came.
    return sample;
  }
}
