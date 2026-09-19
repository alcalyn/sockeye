<script setup lang="ts">
import { computed } from 'vue';
import * as fmt from './format';
import { useMarkers } from './markers';
import type { HistogramBucket } from './types';

/** A bucket always carries a count; a timeline bucket also carries the bytes it moved. */
type Bucket = HistogramBucket & { bytes?: number };

const props = withDefaults(
  defineProps<{
    buckets: Bucket[];
    /** How a bucket bound should be rendered (bytes, milliseconds, a time of day). */
    format: (value: number) => string;
    /** What the vertical axis measures. */
    unit?: string;
    /** Which number of a bucket the bars stand for. */
    metric?: 'count' | 'bytes';
    /**
     * Whether the bucket bounds are moments in time. Only then do the viewer's markers
     * mean anything: a payload size axis has no date to point at.
     */
    timeAxis?: boolean;
  }>(),
  { unit: 'messages', metric: 'count', timeAxis: false },
);

const markers = useMarkers();

/** The number the bars stand for, whichever of the two the chart was asked for. */
function value(bucket: Bucket): number {
  return props.metric === 'bytes' ? (bucket.bytes ?? 0) : bucket.count;
}

function formatValue(amount: number): string {
  return props.metric === 'bytes' ? fmt.bytes(amount) : amount.toLocaleString();
}

const peak = computed(() => Math.max(1, ...props.buckets.map(value)));

/**
 * Round the top of the scale up to something readable: 1, 2, 5, 10, 20, 50… Bytes climb
 * by 1024 rather than by 10, so that a gridline lands on a round kB or MB.
 */
const scaleMax = computed(() => {
  const base = props.metric === 'bytes' ? 1024 : 10;
  const magnitude = base ** Math.floor(Math.log(peak.value) / Math.log(base));
  const steps = base === 1024 ? [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024] : [1, 2, 5, 10];
  const step = steps.find((candidate) => candidate * magnitude >= peak.value) ?? base;
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

/**
 * The viewer's markers that fall inside the period on screen, placed by interpolating
 * between the first bucket's start and the last one's end.
 */
const marks = computed(() => {
  const first = props.buckets[0];
  const last = props.buckets[props.buckets.length - 1];
  if (!props.timeAxis || !first || !last) return [];

  const span = last.to - first.from;
  if (span <= 0) return [];

  return markers.value
    .filter((marker) => marker.at >= first.from && marker.at <= last.to)
    .map((marker) => {
      const position = ((marker.at - first.from) / span) * 100;
      return {
        id: marker.id,
        name: marker.name,
        position,
        title: `${marker.name} - ${new Date(marker.at).toLocaleString()}`,
        // Past the middle, a label written to the right would run out of the plot.
        flipped: position > 60,
      };
    });
});

const title = (bucket: Bucket): string =>
  `${props.format(bucket.from)} - ${props.format(bucket.to)}: ${formatValue(value(bucket))} ${props.unit}`;
</script>

<template>
  <div v-if="buckets.length" class="chart">
    <div class="y-axis">
      <span v-for="tick in yTicks" :key="tick">{{ formatValue(tick) }}</span>
    </div>

    <div class="plot">
      <div class="gridline" style="bottom: 100%" />
      <div class="gridline" style="bottom: 50%" />
      <div
        v-for="bucket in buckets"
        :key="bucket.from"
        class="col"
        :style="{ height: `${Math.max(1.5, (value(bucket) / scaleMax) * 100)}%` }"
        :title="title(bucket)"
      />

      <div
        v-for="mark in marks"
        :key="mark.id"
        class="marker"
        :class="{ flipped: mark.flipped }"
        :style="{ left: `${mark.position}%` }"
        :title="mark.title"
      >
        <span class="marker-label">{{ mark.name }}</span>
      </div>
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
