<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const title = computed(() => route.meta.title ?? '管理后台');
</script>

<template>
  <section class="placeholder-card">
    <div class="placeholder-icon">⌛</div>
    <h1>{{ title }}</h1>
    <p>本页将在后续阶段实现。</p>
  </section>
</template>

<style scoped>
.placeholder-card {
  display: grid;
  min-height: 360px;
  place-content: center;
  text-align: center;
  background: #fff;
  border: 1px solid #e8edf5;
  border-radius: 14px;
  box-shadow: 0 10px 35px rgb(31 41 55 / 5%);
}

.placeholder-icon {
  font-size: 34px;
}

h1 {
  margin: 14px 0 6px;
  font-size: 24px;
}

p {
  margin: 0;
  color: #7a8495;
}
</style>
