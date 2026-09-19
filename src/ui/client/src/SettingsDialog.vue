<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { addMarker, removeMarker, useMarkers } from './markers';

const emit = defineEmits<{ close: []; reset: [] }>();

const markers = useMarkers();
const name = ref('');
const at = ref(localInput(Date.now()));

/** `datetime-local` wants a local `YYYY-MM-DDTHH:mm`, never an ISO instant in UTC. */
function localInput(timestamp: number): string {
  const local = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** The instant the form describes, or `null` while the date input is empty or half typed. */
const instant = computed(() => {
  const value = new Date(at.value).getTime();
  return Number.isFinite(value) ? value : null;
});

const canAdd = computed(() => name.value.trim() !== '' && instant.value !== null);

function add(): void {
  if (instant.value === null || name.value.trim() === '') return;
  addMarker(name.value.trim(), instant.value);
  name.value = '';
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => globalThis.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => globalThis.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Settings">
      <header class="topbar">
        <h1>Settings</h1>
        <div class="spacer" />
        <button class="ghost" @click="emit('close')">Close</button>
      </header>

      <section class="panel">
        <h2>Markers</h2>
        <div class="markers">
          <p class="hint">
            A named moment — a release, a deploy, the start of a load test — drawn as a
            vertical line on every time chart whose period contains it. Markers are kept in
            this browser.
          </p>

          <form class="marker-form" @submit.prevent="add">
            <input v-model="name" type="text" placeholder="release v2" aria-label="Marker name" />
            <input v-model="at" type="datetime-local" aria-label="Marker date and time" />
            <button type="submit" :disabled="!canAdd">Add</button>
          </form>

          <ul v-if="markers.length" class="marker-list">
            <li v-for="marker in markers" :key="marker.id">
              <span class="marker-name">{{ marker.name }}</span>
              <span class="muted">{{ new Date(marker.at).toLocaleString() }}</span>
              <button
                class="link"
                :aria-label="`Remove ${marker.name}`"
                @click="removeMarker(marker.id)"
              >
                Remove
              </button>
            </li>
          </ul>
          <p v-else class="hint">No marker yet.</p>
        </div>
      </section>

      <section class="panel danger">
        <h2>Danger zone</h2>
        <div class="danger-row">
          <p>
            Resetting drops every metric collected so far: counts, payload sizes and response
            times, for every message type and namespace. The dashboard starts from an empty
            store and fills again as new traffic comes in. This cannot be undone.
          </p>
          <button class="danger" @click="emit('reset')">Reset all metrics</button>
        </div>
      </section>
    </div>
  </div>
</template>
