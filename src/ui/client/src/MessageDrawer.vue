<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import HistogramChart from './HistogramChart.vue';
import PayloadSamples from './PayloadSamples.vue';
import { fetchMessage } from './api';
import * as fmt from './format';
import type { MessageDetail } from './types';

/** Length of one history bucket, which drives how its axis is labelled. */
function bucketSize(detail: MessageDetail): number {
  const first = detail.timeline[0];
  return first ? first.to - first.from : 60_000;
}

function bucketUnit(detail: MessageDetail): string {
  return fmt.unit(bucketSize(detail));
}

/** Examples from every direction of this message, heaviest first. */
const allSamples = computed(() =>
  details.value
    .flatMap((detail) => detail.samples)
    .sort((a, b) => b.bytes - a.bytes),
);

const props = defineProps<{
  name: string | null;
  window: string;
  /** Polling cadence, shared with the dashboard behind the drawer. */
  intervalMs: number;
  paused: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const details = ref<MessageDetail[]>([]);
const error = ref<string | null>(null);
const loading = ref(false);

/**
 * Identifies the request whose answer is still wanted.
 *
 * The drawer keeps polling while it is open, so a slow response can land after the
 * viewer has already picked another message; anything but the latest is dropped.
 */
let token = 0;

/** `refresh` keeps the numbers on screen while the next poll is in flight. */
async function load(mode: 'open' | 'refresh'): Promise<void> {
  const name = props.name;
  if (!name) return;

  const mine = ++token;
  if (mode === 'open') {
    loading.value = true;
    error.value = null;
  }

  try {
    const next = await fetchMessage(name, props.window);
    if (mine !== token) return;
    details.value = next;
    error.value = null;
  } catch (cause) {
    if (mine !== token) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (mine === token) loading.value = false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

function schedule(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  // Nothing to poll for a closed drawer, and a paused dashboard stays paused here too.
  if (!props.name || props.paused) return;
  timer = setInterval(() => void load('refresh'), props.intervalMs);
}

// A new message, or a new period, is a fresh read: show the spinner rather than the
// numbers of the message being replaced.
watch(
  () => [props.name, props.window],
  () => {
    void load('open');
    schedule();
  },
  { immediate: true },
);

watch(() => [props.intervalMs, props.paused], schedule);

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div v-if="name" class="drawer-backdrop" @click.self="emit('close')">
    <aside class="drawer">
      <header class="topbar">
        <h1 class="mono">{{ name }}</h1>
        <div class="spacer" />
        <button class="ghost" @click="emit('close')">Close</button>
      </header>

      <p v-if="loading" class="empty">Loading…</p>
      <p v-else-if="error" class="error">{{ error }}</p>

      <section v-for="detail in details" :key="`${detail.namespace}/${detail.direction}`" class="panel">
        <h2>
          <span class="tag" :class="detail.direction">{{ detail.direction }}</span>
          {{ detail.namespace }} · {{ fmt.count(detail.count) }} messages
        </h2>

        <dl class="stats">
          <div>
            <dt>Bandwidth</dt>
            <dd>{{ fmt.bytes(detail.totalBytes) }}</dd>
          </div>
          <div>
            <dt>Payload median</dt>
            <dd>{{ fmt.bytes(detail.bytes.p50) }}</dd>
          </div>
          <div>
            <dt>Payload avg</dt>
            <dd>{{ fmt.bytes(Math.round(detail.bytes.avg)) }}</dd>
          </div>
          <div>
            <dt>Payload p95</dt>
            <dd>{{ fmt.bytes(detail.bytes.p95) }}</dd>
          </div>
          <div>
            <dt>Payload max</dt>
            <dd>{{ fmt.bytes(detail.bytes.max) }}</dd>
          </div>
        </dl>

        <h2>Over time: how many messages per {{ bucketUnit(detail) }}</h2>
        <HistogramChart
          :buckets="detail.timeline"
          :format="fmt.clockFor(bucketSize(detail))"
          unit="messages"
        />

        <h2>Over time: bandwidth per {{ bucketUnit(detail) }}</h2>
        <HistogramChart
          :buckets="detail.timeline"
          :format="fmt.clockFor(bucketSize(detail))"
          metric="bytes"
          unit="bandwidth"
        />

        <h2>Payload sizes: how many messages per size</h2>
        <HistogramChart :buckets="detail.bytesHistogram" :format="fmt.bytes" unit="messages" />

        <template v-if="detail.latency">
          <dl class="stats">
            <div>
              <dt>Median</dt>
              <dd>{{ fmt.ms(detail.latency.p50) }}</dd>
            </div>
            <div>
              <dt>Average</dt>
              <dd>{{ fmt.ms(detail.latency.avg) }}</dd>
            </div>
            <div>
              <dt>p95</dt>
              <dd>{{ fmt.ms(detail.latency.p95) }}</dd>
            </div>
            <div>
              <dt>p99</dt>
              <dd>{{ fmt.ms(detail.latency.p99) }}</dd>
            </div>
            <div>
              <dt>Max</dt>
              <dd>{{ fmt.ms(detail.latency.max) }}</dd>
            </div>
          </dl>

          <h2>Response times: how many replies per duration</h2>
          <HistogramChart :buckets="detail.latencyHistogram" :format="fmt.ms" unit="replies" />
        </template>
      </section>

      <PayloadSamples v-if="details.length" :samples="allSamples" />

      <p v-if="!loading && !error && !details.length" class="empty">
        Nothing recorded for this message in the selected period.
      </p>
    </aside>
  </div>
</template>
