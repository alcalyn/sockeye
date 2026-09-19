import { ref, type Ref } from 'vue';

/** A named moment the viewer wants to see on every time chart. */
export interface Marker {
  id: string;
  name: string;
  /** Epoch milliseconds. */
  at: number;
}

const STORAGE_KEY = 'sockeye.markers';

function stored(): Marker[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMarker).sort((a, b) => a.at - b.at);
  } catch {
    // Private windows, blocked site data, or something else writing to the key.
    return [];
  }
}

function isMarker(value: unknown): value is Marker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Partial<Marker>;
  return (
    typeof marker.id === 'string' &&
    typeof marker.name === 'string' &&
    typeof marker.at === 'number' &&
    Number.isFinite(marker.at)
  );
}

// One list for the whole page: the settings dialog edits it, every time chart reads it.
const markers = ref<Marker[]>(stored());

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(markers.value));
  } catch {
    // The markers just won't survive a reload.
  }
}

/** The shared list, oldest first. Edit it through `addMarker` / `removeMarker`. */
export function useMarkers(): Ref<Marker[]> {
  return markers;
}

export function addMarker(name: string, at: number): void {
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `${at.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  markers.value = [...markers.value, { id, name, at }].sort((a, b) => a.at - b.at);
  persist();
}

export function removeMarker(id: string): void {
  markers.value = markers.value.filter((marker) => marker.id !== id);
  persist();
}
