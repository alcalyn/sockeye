<script setup lang="ts" generic="T extends string | number">
/**
 * A <select> isolated behind a component boundary.
 *
 * `v-model` on a select installs a directive whose `updated` hook reassigns
 * `option.selected` on every patch. The dashboard re-renders once per poll, so
 * leaving the select in App.vue made an open native dropdown jump every second.
 * Here it only re-renders when the value or the options actually change.
 */
const props = defineProps<{
  modelValue: T;
  options: readonly { value: T; label: string }[];
  title?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: T] }>();

/** The DOM only knows strings, so hand back the option's own value. */
function onChange(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  const option = props.options.find((o) => String(o.value) === raw);
  if (option) emit('update:modelValue', option.value);
}
</script>

<template>
  <select :title="title" :value="modelValue" @change="onChange">
    <option v-for="option in options" :key="option.value" :value="option.value">
      {{ option.label }}
    </option>
  </select>
</template>
