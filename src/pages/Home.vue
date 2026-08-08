<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { supabase } from '../lib/supabase';

const status = ref<'checking' | 'connected' | 'error'>('checking');
const detail = ref('');

onMounted(async () => {
  try {
    const { error } = await supabase.auth.getSession();
    if (error) throw error;
    status.value = 'connected';
    detail.value = import.meta.env.VITE_SUPABASE_URL;
  } catch (e) {
    status.value = 'error';
    detail.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <main class="wrap">
    <h1>Arrow Flight Tracking</h1>
    <p class="sub">Rebuild in progress — new stack on Arrow infrastructure.</p>
    <p :class="['status', status]">
      <template v-if="status === 'checking'">Checking backend…</template>
      <template v-else-if="status === 'connected'">✓ Connected to Supabase ({{ detail }})</template>
      <template v-else>✗ Backend error: {{ detail }}</template>
    </p>
  </main>
</template>

<style>
body { margin: 0; font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
.wrap { max-width: 640px; margin: 18vh auto 0; padding: 0 1.5rem; }
h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
.sub { color: #8b949e; margin-top: 0; }
.status { margin-top: 2rem; padding: 0.75rem 1rem; border-radius: 8px; background: #161b22; }
.status.connected { color: #3fb950; }
.status.error { color: #f85149; }
</style>
