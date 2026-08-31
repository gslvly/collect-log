<template>
  <div :class="['v-dialog', fixTop ? 'fixed-top' : 'center']" role="dialog" aria-modal="true">
    <div v-loading="loading" class="v-dialog-body" :style="{ width }">
      <el-icon v-if="showClose" class="close-icon" tabindex="0" @click="close" @keyup.enter="close">
        <Close />
      </el-icon>
      <header v-if="hasSlots($slots.header?.({}))" class="header v-dialog-header">
        <slot name="header"></slot>
      </header>
      <main class="content v-dialog-content">
        <slot name="body"></slot>
      </main>
      <div v-if="hasSlots($slots.default?.({}))" class="v-dialog-footer">
        <slot></slot>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts" name="VDialog">
import { Close } from '@element-plus/icons-vue';
import { Comment, Fragment, Text, type VNode } from 'vue';

withDefaults(
  defineProps<{
    /**固定顶部6vh */
    fixTop?: boolean;
    showClose?: boolean;
    loading?: boolean;
    width?: string;
  }>(),
  { showClose: true, width: 'min(800px, calc(100vw - 32px))' },
);

const emit = defineEmits<{
  (e: 'close'): void;
}>();
const close = () => {
  emit('close');
};
const isEmptyVNode = (it: VNode) =>
  it.type === Comment ||
  (it.type === Fragment && !it.children?.length) ||
  (it.type === Text && !it.children);

const hasSlots = (children?: VNode[]) => children?.some((it) => !isEmptyVNode(it)) === true;
</script>

<style scoped>
.v-dialog {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.3);
  z-index: 2100;
  display: flex;
}

.v-dialog.center {
  flex-direction: column;
  align-items: center;
}

.v-dialog.center::after {
  flex: 2 0 0;
  content: '';
}

.v-dialog.center::before {
  flex: 1 0 0;
  content: '';
}

.v-dialog.center .v-dialog-body {
  flex: 0 0 auto;
  max-height: 90vh;
  height: fit-content;
}

.v-dialog.center .v-dialog-content {
  flex: 1 1 auto;
}

.v-dialog.fixed-top {
  justify-content: center;
  padding-top: 6vh;
  padding-bottom: 9vh;
}

.v-dialog.fixed-top .v-dialog-body {
  max-height: 85vh;
  height: fit-content;
}

.v-dialog-body {
  position: relative;
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - 32px);
  background-color: #fff;
  border-radius: 6px;
  box-shadow: 0 8px 16px 0 rgb(0 11 32 / 15%);
}

.close-icon {
  position: absolute;
  top: 16px;
  right: 16px;
  cursor: pointer;
  font-size: 16px;
  color: #66738c;
}

.close-icon:hover,
.close-icon:focus-visible {
  color: #409eff;
}

.v-dialog-header {
  box-sizing: border-box;
  flex: 0 0 auto;
  min-height: 50px;
  padding: 32px 32px 16px;
  font-size: 20px;
  font-weight: bold;
  color: #001640;
}

.v-dialog-content {
  height: auto;
  padding: 0 32px 24px;
  overflow: auto;
}

.v-dialog-footer {
  flex: 0 0 auto;
  padding: 0 32px 32px;
}
</style>
