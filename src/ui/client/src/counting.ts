import { ref, type Ref } from 'vue';
import type { CountingMode } from './types';

const STORAGE_KEY = 'sockeye.counting';

function stored(): CountingMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'emit' ? 'emit' : 'sent';
  } catch {
    // Private windows, blocked site data: fall back to the default.
    return 'sent';
  }
}

/**
 * How the whole page counts a message, by default once per client it reached.
 *
 * One setting for the whole page: the table's switch writes it, and the headline cards and
 * the charts read it, so every number on screen counts the same way.
 */
const counting = ref<CountingMode>(stored());

export function useCounting(): Ref<CountingMode> {
  return counting;
}

export function setCounting(mode: CountingMode): void {
  counting.value = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // The choice just won't survive a reload.
  }
}

/** Pick the right pair of numbers out of anything carrying both. */
export function countOf(stats: { count: number; sentCount: number }): number {
  return counting.value === 'emit' ? stats.count : stats.sentCount;
}

export function bytesOf(stats: { bytes: number; sentBytes: number }): number {
  return counting.value === 'emit' ? stats.bytes : stats.sentBytes;
}
