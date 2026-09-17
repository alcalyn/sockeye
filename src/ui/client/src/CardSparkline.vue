<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  /** One value per time bucket, oldest first. */
  values: number[];
}>();

/** Drawn in a unit box and stretched to the card, so no measuring is needed. */
const WIDTH = 100;
const HEIGHT = 100;

const peak = computed(() => Math.max(0, ...props.values));

/** Nothing to show for a flat zero line, or for a single point that has no shape yet. */
const visible = computed(() => props.values.length > 1 && peak.value > 0);

const points = computed(() =>
  props.values.map((value, index) => {
    const x = (index / (props.values.length - 1)) * WIDTH;
    // A bucket at the peak is left a sliver of headroom rather than touching the edge.
    const y = HEIGHT - (value / peak.value) * (HEIGHT - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }),
);

const line = computed(() => `M${points.value.join(' L')}`);
const area = computed(() => `${line.value} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`);
</script>

<template>
  <svg
    v-if="visible"
    class="sparkline"
    :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
    preserveAspectRatio="none"
    aria-hidden="true"
    focusable="false"
  >
    <path class="fill" :d="area" />
    <path class="stroke" :d="line" />
  </svg>
</template>
