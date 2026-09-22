<script setup lang="ts">
import { computed, ref } from 'vue';
import ToolbarSelect from './ToolbarSelect.vue';
import * as fmt from './format';
import { setCounting, useCounting } from './counting';
import type { CountingMode, MessageStats, SortKey } from './types';

const props = defineProps<{ messages: MessageStats[] }>();
const emit = defineEmits<{ select: [name: string] }>();

const counting = useCounting();

/**
 * The two ways of counting a message. `per client` is the default: one broadcast to a room
 * of ten is ten messages and ten payloads, which is what the server actually pushed out.
 */
const COUNTING: Array<{ value: CountingMode; label: string; hint: string }> = [
  {
    value: 'sent',
    label: 'Per client',
    hint: 'Count every copy sent: a broadcast to ten clients counts ten times',
  },
  {
    value: 'emit',
    label: 'Per emit',
    hint: 'Count every call once, whatever the number of recipients',
  },
];

const sort = ref<SortKey>('count');
const direction = ref<'all' | 'in' | 'out'>('all');

/** 0 lifts the limit; the rest are the row counts offered. */
const LIMITS = [
  { value: 8, label: 'Top 8' },
  { value: 15, label: 'Top 15' },
  { value: 30, label: 'Top 30' },
  { value: 50, label: 'Top 50' },
  { value: 75, label: 'Top 75' },
  { value: 100, label: 'Top 100' },
  { value: 0, label: 'All' },
];
const limit = ref(15);

const columns = computed<Array<{ key: SortKey; label: string; hint?: string }>>(() => {
  const perClient = counting.value === 'sent';
  return [
    { key: 'name', label: 'Message' },
    {
      key: 'count',
      label: 'Count',
      hint: perClient
        ? 'Messages pushed to a client, so a broadcast counts once per recipient'
        : 'Calls to emit, whatever the number of recipients',
    },
    {
      key: 'bandwidth',
      label: 'Total data',
      hint: perClient
        ? 'Every payload multiplied by the clients it reached: a total, not a rate'
        : 'Sum of every payload, counted once per emit: a total, not a rate',
    },
    { key: 'bytes', label: 'Payload', hint: 'Median / average size of one message' },
    { key: 'latency', label: 'Response time', hint: 'Median / p95' },
  ];
});

/** The number a row is ranked and drawn by, for a given column. */
function value(message: MessageStats, key: SortKey): number {
  switch (key) {
    case 'count':
      return counting.value === 'emit' ? message.count : message.sentCount;
    case 'bandwidth':
      return counting.value === 'emit' ? message.totalBytes : message.sentBytes;
    case 'bytes':
      return message.bytes.p50;
    case 'latency':
      return message.latency ? message.latency.p50 : -1;
    default:
      return 0;
  }
}

const rows = computed(() => {
  const filtered =
    direction.value === 'all'
      ? props.messages
      : props.messages.filter((message) => message.direction === direction.value);

  return [...filtered].sort((a, b) =>
    sort.value === 'name' ? a.name.localeCompare(b.name) : value(b, sort.value) - value(a, sort.value),
  );
});

const visible = computed(() =>
  limit.value === 0 ? rows.value : rows.value.slice(0, limit.value),
);

/** Each column is drawn against its own maximum, so every bar is readable. */
const maxima = computed(() => {
  const keys: SortKey[] = ['count', 'bandwidth', 'bytes', 'latency'];
  const out = {} as Record<SortKey, number>;
  for (const key of keys) out[key] = Math.max(1, ...rows.value.map((row) => value(row, key)));
  return out;
});

function width(message: MessageStats, key: SortKey): string {
  const share = Math.max(0, value(message, key)) / maxima.value[key];
  return `${Math.max(share * 100, share > 0 ? 1 : 0)}%`;
}

const hasNamespaces = computed(() => new Set(props.messages.map((m) => m.namespace)).size > 1);
</script>

<template>
  <section class="panel">
    <h2>
      Messages
      <span class="muted" style="text-transform: none; letter-spacing: 0">
        · sorted by {{ sort }}
      </span>
    </h2>

    <div style="padding: 10px 16px; display: flex; gap: 6px; align-items: center">
      <button
        v-for="option in (['all', 'in', 'out'] as const)"
        :key="option"
        class="ghost"
        :style="option === direction ? 'border-color: var(--accent); color: var(--accent)' : ''"
        @click="direction = option"
      >
        {{ option === 'all' ? 'All' : option === 'in' ? 'Received' : 'Sent' }}
      </button>
      <div class="spacer" style="flex: 1" />
      <button
        v-for="option in COUNTING"
        :key="option.value"
        class="ghost"
        :style="option.value === counting ? 'border-color: var(--accent); color: var(--accent)' : ''"
        :title="option.hint"
        @click="setCounting(option.value)"
      >
        {{ option.label }}
      </button>
      <ToolbarSelect v-model="limit" :options="LIMITS" title="Rows shown" />
    </div>

    <table>
      <thead>
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            class="sortable"
            :class="{ active: sort === column.key }"
            :title="column.hint"
            @click="sort = column.key"
          >
            {{ column.label }}
          </th>
          <th v-if="hasNamespaces">Namespace</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="message in visible"
          :key="`${message.namespace}/${message.direction}/${message.name}`"
          @click="emit('select', message.name)"
        >
          <td>
            <span class="mono">{{ message.name }}</span>
            <span class="tag" :class="message.direction">{{ message.direction }}</span>
          </td>

          <td class="num">
            {{ fmt.count(value(message, 'count')) }}
            <div class="cell-bar" :style="{ width: width(message, 'count') }" />
          </td>

          <td class="num">
            {{ fmt.bytes(value(message, 'bandwidth')) }}
            <div class="cell-bar" :style="{ width: width(message, 'bandwidth') }" />
          </td>

          <td class="num">
            {{ fmt.bytes(message.bytes.p50) }}
            <span class="muted">/ {{ fmt.bytes(Math.round(message.bytes.avg)) }}</span>
            <div class="cell-bar" :style="{ width: width(message, 'bytes') }" />
          </td>

          <td class="num">
            <template v-if="message.latency">
              {{ fmt.ms(message.latency.p50) }}
              <span class="muted">/ {{ fmt.ms(message.latency.p95) }}</span>
              <div class="cell-bar" :style="{ width: width(message, 'latency') }" />
            </template>
            <span v-else class="muted">-</span>
          </td>

          <td v-if="hasNamespaces" class="muted mono">{{ message.namespace }}</td>
        </tr>
      </tbody>
    </table>

    <p v-if="!rows.length" class="empty">No message recorded in this period.</p>

    <p v-else-if="visible.length < rows.length" class="truncated muted">
      Showing {{ visible.length }} of {{ fmt.count(rows.length) }} messages.
    </p>
  </section>
</template>
