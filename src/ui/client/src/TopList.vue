<script setup lang="ts">
import { computed, ref } from 'vue';
import * as fmt from './format';
import type { TopEntry } from './types';

const props = defineProps<{
  title: string;
  entries: TopEntry[];
  /** Which number makes an entry rank: its latency or its size. */
  metric: 'latency' | 'bytes';
  format: (value: number) => string;
}>();

const emit = defineEmits<{ select: [name: string] }>();

const opened = ref<number | null>(null);

const score = (entry: TopEntry): number =>
  props.metric === 'latency' ? (entry.latencyMs ?? 0) : entry.bytes;

const max = computed(() => Math.max(1, ...props.entries.map(score)));

function toggle(index: number): void {
  opened.value = opened.value === index ? null : index;
}
</script>

<template>
  <section class="panel">
    <h2>{{ title }}</h2>
    <p v-if="!entries.length" class="empty">Nothing recorded yet.</p>

    <div v-for="(entry, index) in entries" :key="index" class="bar-row">
      <div>
        <span class="mono" style="cursor: pointer" @click="emit('select', entry.name)">
          {{ entry.name }}
        </span>
        <span class="tag" :class="entry.direction">{{ entry.direction }}</span>
        <button v-if="entry.sample" class="link" @click="toggle(index)">
          {{ opened === index ? 'hide payload' : 'payload' }}
        </button>
        <span v-if="metric === 'latency'" class="muted" style="margin-left: 10px">
          {{ fmt.bytes(entry.bytes) }}
        </span>
        <span class="muted" style="margin-left: 10px">{{ fmt.moment(entry.timestamp) }}</span>
        <div class="bar" :style="{ width: `${(score(entry) / max) * 100}%` }" />
      </div>
      <strong class="num">{{ format(score(entry)) }}</strong>

      <pre v-if="opened === index && entry.sample" class="payload">{{ fmt.payload(entry.sample) }}</pre>
    </div>
  </section>
</template>
