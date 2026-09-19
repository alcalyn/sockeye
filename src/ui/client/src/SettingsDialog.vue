<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

const emit = defineEmits<{ close: []; reset: [] }>();

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
