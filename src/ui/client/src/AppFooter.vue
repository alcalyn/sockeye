<script setup lang="ts">
const REPO = 'https://github.com/alcalyn/sockeye';

const version = __SOCKEYE_VERSION__;
</script>

<template>
  <footer class="footer">
    <a :href="REPO" target="_blank" rel="noopener">⭐ Star sockeye on GitHub</a>
    <span class="sep">·</span>
    <a :href="`${REPO}/issues`" target="_blank" rel="noopener">Report an issue</a>
    <span class="sep">·</span>
    <a :href="`${REPO}/blob/main/LICENSE`" target="_blank" rel="noopener">AGPL-3.0</a>
    <span class="sep">·</span>
    <a href="https://github.com/alcalyn" target="_blank" rel="noopener">by @alcalyn</a>
    <span class="sep">·</span>
    <a :href="`${REPO}/releases`" target="_blank" rel="noopener" class="mono">v{{ version }}</a>
  </footer>
</template>
