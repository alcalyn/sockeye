import { ref, watch } from 'vue';

export type Theme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'sockeye.theme';

function stored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // Private windows and blocked site data: fall back to the system preference.
  }
  return 'system';
}

/** `system` removes the attribute, letting `prefers-color-scheme` decide. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function useTheme() {
  const theme = ref<Theme>(stored());

  watch(
    theme,
    (value) => {
      applyTheme(value);
      try {
        localStorage.setItem(STORAGE_KEY, value);
      } catch {
        // The choice just won't survive a reload.
      }
    },
    { immediate: true },
  );

  return theme;
}
