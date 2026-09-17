<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import CardSparkline from './CardSparkline.vue';
import MessageDrawer from './MessageDrawer.vue';
import MessagesTable from './MessagesTable.vue';
import ToolbarSelect from './ToolbarSelect.vue';
import TopList from './TopList.vue';
import { fetchDashboard, resetStore } from './api';
import { useTheme } from './theme';
import * as fmt from './format';
import type { Dashboard, WindowRange } from './types';

const data = ref<Dashboard | null>(null);
// Kept out of `data` on purpose: every poll brings back windows with fresh
// `from`/`to` timestamps, and rebuilding the <option>s from those made the open
// period dropdown flicker once a second. Only the key and the label are rendered.
const windows = ref<{ key: string; label: string }[]>([]);
const error = ref<string | null>(null);
const selected = ref<string | null>(null);
const intervalMs = ref(2000);
const paused = ref(false);
// `auto` lets the store pick: the finest period its history does not fill yet, so a
// dashboard opened on a fresh process shows the last minute rather than a week of gaps.
const window_ = ref('auto');
const theme = useTheme();

// A half-filled disc is the usual "follow the system" mark, next to the sun and the moon.
const THEMES = {
  system: { icon: '◐', label: 'auto' },
  light: { icon: '☀️', label: 'light' },
  dark: { icon: '🌙', label: 'dark' },
} as const;
const themeIcon = computed(() => THEMES[theme.value].icon);
const themeLabel = computed(() => THEMES[theme.value].label);

/** System → light → dark → system. */
function cycleTheme(): void {
  const order = ['system', 'light', 'dark'] as const;
  theme.value = order[(order.indexOf(theme.value) + 1) % order.length];
}

function sameWindows(current: { key: string; label: string }[], next: WindowRange[]): boolean {
  return (
    current.length === next.length &&
    current.every((w, i) => w.key === next[i].key && w.label === next[i].label)
  );
}

let timer: ReturnType<typeof setInterval> | undefined;

async function refresh(): Promise<void> {
  try {
    const next = await fetchDashboard(window_.value);
    data.value = next;
    if (!sameWindows(windows.value, next.windows)) {
      windows.value = next.windows.map((w) => ({ key: w.key, label: w.label }));
    }
    error.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function schedule(): void {
  if (timer) clearInterval(timer);
  if (!paused.value) timer = setInterval(refresh, intervalMs.value);
}

function togglePause(): void {
  paused.value = !paused.value;
  schedule();
}

async function reset(): Promise<void> {
  if (!globalThis.confirm('Drop every metric collected so far?')) return;
  try {
    await resetStore();
    await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

watch(window_, refresh);
watch(intervalMs, schedule);

onMounted(() => {
  void refresh();
  schedule();
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const overview = computed(() => data.value?.overview ?? null);
// The two headline cards carry their own history behind the number: how the traffic got
// there, on the same time axis for both.
const timeline = computed(() => overview.value?.timeline ?? []);
const messagesOverTime = computed(() => timeline.value.map((bucket) => bucket.count));
const bytesOverTime = computed(() => timeline.value.map((bucket) => bucket.bytes));
const periodOptions = computed(() => [
  { value: 'auto', label: 'Auto' },
  ...windows.value.filter((w) => w.key !== 'all').map((w) => ({ value: w.key, label: w.label })),
]);

const INTERVAL_OPTIONS = [
  { value: 1000, label: '1s' },
  { value: 2000, label: '2s' },
  { value: 5000, label: '5s' },
  { value: 15000, label: '15s' },
];
/** What the numbers actually cover: for `auto`, the period the store settled on. */
const period = computed(() => {
  const resolved = overview.value?.window;
  if (resolved) return resolved.label;
  return window_.value === 'all' ? 'all time' : window_.value;
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <h1>🐟 sockeye</h1>
      <span v-if="data" class="muted">updated {{ fmt.time(data.generatedAt) }}</span>
      <div class="spacer" />
      <ToolbarSelect
        v-model="window_"
        :options="periodOptions"
        title="Period the numbers below cover"
      />
      <ToolbarSelect
        v-model="intervalMs"
        :options="INTERVAL_OPTIONS"
        title="Refresh interval"
      />
      <button class="ghost" @click="togglePause">{{ paused ? 'Resume' : 'Pause' }}</button>
      <button class="ghost" @click="refresh">Refresh</button>
      <button class="ghost" @click="reset">Reset</button>
      <button
        class="icon-button"
        :title="`Theme: ${themeLabel}. Click to switch.`"
        :aria-label="`Theme: ${themeLabel}`"
        @click="cycleTheme"
      >
        {{ themeIcon }}
      </button>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="overview" class="cards">
      <div class="card">
        <CardSparkline :values="messagesOverTime" />
        <div class="label">Messages</div>
        <div class="value">{{ fmt.count(overview.totalMessages) }}</div>
        <div class="hint">
          {{ fmt.count(overview.in.count) }} in · {{ fmt.count(overview.out.count) }} out
        </div>
      </div>
      <div class="card">
        <CardSparkline :values="bytesOverTime" />
        <div class="label">Total data</div>
        <div class="value">{{ fmt.bytes(overview.totalBytes) }}</div>
        <div class="hint">
          {{ fmt.bytes(overview.in.bytes) }} in · {{ fmt.bytes(overview.out.bytes) }} out
        </div>
        <div class="hint">
          {{ fmt.rate(overview.totalBytes, overview.firstSeen, overview.lastSeen) }} on average
        </div>
      </div>
      <div class="card">
        <div class="label">Message types</div>
        <div class="value">{{ fmt.count(overview.messageTypes) }}</div>
        <div class="hint">across every namespace</div>
      </div>
      <div class="card">
        <div class="label">Period</div>
        <div class="value">{{ period }}</div>
        <div v-if="window_ === 'auto'" class="hint">
          chosen automatically: the finest period the history fills
        </div>
        <div class="hint">{{ fmt.coverage(overview.window) }}</div>
        <div class="hint">every number below is a total over this period</div>
      </div>
    </div>

    <MessagesTable :messages="data?.messages ?? []" @select="selected = $event" />

    <div class="columns">
      <TopList
        title="Slowest responses"
        metric="latency"
        :entries="data?.top.slowest ?? []"
        :format="fmt.ms"
        @select="selected = $event"
      />
      <TopList
        title="Heaviest payloads"
        metric="bytes"
        :entries="data?.top.heaviest ?? []"
        :format="fmt.bytes"
        @select="selected = $event"
      />
    </div>

    <MessageDrawer
      :name="selected"
      :window="window_"
      :interval-ms="intervalMs"
      :paused="paused"
      @close="selected = null"
    />
  </div>
</template>
