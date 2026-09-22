import type { CountingMode, Dashboard, MessageDetail } from './types';

/**
 * The API lives next to the page, whatever path the dashboard was mounted on
 * (`/sockeye/`, `/admin/ws/`, the root in dev...).
 */
function apiBase(): string {
  const path = window.location.pathname;
  return `${path.endsWith('/') ? path : `${path}/`}api`;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchDashboard(window: string, counting: CountingMode): Promise<Dashboard> {
  // The server sorts and trims the list, so it has to count the same way the page does.
  return get<Dashboard>(
    `/dashboard?window=${encodeURIComponent(window)}&counting=${encodeURIComponent(counting)}`,
  );
}

export function fetchMessage(name: string, window: string): Promise<MessageDetail[]> {
  return get<MessageDetail[]>(
    `/messages/${encodeURIComponent(name)}?window=${encodeURIComponent(window)}`,
  );
}

export async function resetStore(): Promise<void> {
  const response = await fetch(`${apiBase()}/reset`, { method: 'POST' });
  if (!response.ok) throw new Error('This store does not support reset');
}
