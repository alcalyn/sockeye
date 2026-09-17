<script setup lang="ts">
import { computed } from 'vue';
import type { HistogramBucket } from './types';

const props = withDefaults(
  defineProps<{
    buckets: HistogramBucket[];
    /** How a bucket bound should be rendered (bytes, milliseconds, a time of day). */
    format: (value: number) => string;
    /** What the vertical axis counts. */
    unit?: string;
  }>(),
  { unit: 'messages' },
);

const peak = computed(() => Math.max(1, ...props.buckets.map((bucket) => bucket.count)));

/** Round the top of the scale up to something readable: 1, 2, 5, 10, 20, 50… */
const scaleMax = computed(() => {
  const magnitude = 10 ** Math.floor(Math.log10(peak.value));
  const step = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= peak.value) ?? 10;
  return step * magnitude;
});

/** Three gridlines: 0, half and the top of the scale. */
const yTicks = computed(() => [scaleMax.value, scaleMax.value / 2, 0]);

/**
 * Up to five labels along the value axis, each anchored on the middle of the bucket it
 * describes: buckets are not evenly spaced in value, so a label must point at its bar.
 */
const xTicks = computed(() => {
  const count = props.buckets.length;
  if (count === 0) return [];

  const wanted = Math.min(5, count);
  const indexes = new Set<number>();
  for (let i = 0; i < wanted; i++) {
    indexes.add(wanted === 1 ? 0 : Math.round((i * (count - 1)) / (wanted - 1)));
  }

  return [...indexes].sort((a, b) => a - b).map((index) => {
    const bucket = props.buckets[index];
    const position = ((index + 0.5) / count) * 100;
    return {
      index,
      label: props.format(bucket.from),
      position,
      // Keep the outermost labels inside the plot instead of letting them overflow.
      shift: index === 0 ? '0' : index === count - 1 ? '-100%' : '-50%',
    };
  });
});

const title = (bucket: HistogramBucket): string =>
  `${props.format(bucket.from)} - ${props.format(bucket.to)}: ${bucket.count.toLocaleString()} ${props.unit}`;
</script>

<template>
  <div v-if="buckets.length" class="chart">
    <div class="y-axis">
      <span v-for="tick in yTicks" :key="tick">{{ tick.toLocaleString() }}</span>
    </div>

    <div class="plot">
      <div class="gridline" style="bottom: 100%" />
      <div class="gridline" style="bottom: 50%" />
      <div
        v-for="bucket in buckets"
        :key="bucket.from"
        class="col"
        :style="{ height: `${Math.max(1.5, (bucket.count / scaleMax) * 100)}%` }"
        :title="title(bucket)"
      />
    </div>

    <span class="axis-name">{{ unit }}</span>

    <div class="x-axis">
      <span
        v-for="tick in xTicks"
        :key="tick.index"
        :style="{ left: `${tick.position}%`, transform: `translateX(${tick.shift})` }"
      >
        {{ tick.label }}
      </span>
    </div>
  </div>
  <p v-else class="empty">No data yet.</p>
</template>
