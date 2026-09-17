<script setup lang="ts">
import { ref, watch } from 'vue';
import * as fmt from './format';
import type { TopEntry } from './types';

const props = defineProps<{ samples: TopEntry[] }>();

/** The heaviest one is open on arrival: that is the example you came for. */
const opened = ref(new Set<number>([0]));

watch(
  () => props.samples,
  () => {
    opened.value = new Set([0]);
  },
);

function toggle(index: number): void {
  const next = new Set(opened.value);
  if (!next.delete(index)) next.add(index);
  opened.value = next;
}
</script>

<template>
  <section class="panel">
    <h2>
      Payload examples
      <span class="muted" style="text-transform: none; letter-spacing: 0">
        · the biggest ones seen, all time
      </span>
    </h2>

    <p v-if="!samples.length" class="empty">
      No payload captured. The collector may have <code>capturePayload: false</code>.
    </p>

    <div v-for="(entry, index) in samples" :key="index" class="bar-row">
      <div>
        <strong>{{ fmt.bytes(entry.bytes) }}</strong>
        <span class="tag" :class="entry.direction">{{ entry.direction }}</span>
        <span class="muted" style="margin-left: 10px">{{ fmt.time(entry.timestamp) }}</span>
        <span v-if="entry.latencyMs !== undefined" class="muted" style="margin-left: 10px">
          answered in {{ fmt.ms(entry.latencyMs) }}
        </span>
      </div>
      <button v-if="entry.sample" class="link" @click="toggle(index)">
        {{ opened.has(index) ? 'hide' : 'show' }}
      </button>
      <span v-else class="muted">not captured</span>

      <pre v-if="entry.sample && opened.has(index)" class="payload">{{ fmt.payload(entry.sample) }}</pre>
    </div>
  </section>
</template>
