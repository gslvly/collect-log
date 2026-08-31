<script setup lang="ts">
import { computed, ref } from 'vue';

import type { FieldOptionInput } from '../api/tables.js';
import {
  cloneEnumOptions,
  moveEnumOption,
  newEnumOption,
  validateEnumOptions,
} from '../enum-options.logic.js';

const props = withDefaults(
  defineProps<{
    modelValue: FieldOptionInput[];
    lockedValues?: readonly string[];
    validationAttempted?: boolean;
  }>(),
  { lockedValues: () => [], validationAttempted: false },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: FieldOptionInput[]): void;
}>();

const draggedIndex = ref<number | null>(null);
const lockedValueSet = computed(() => new Set(props.lockedValues));
const validation = computed(() => validateEnumOptions(props.modelValue));

function isValueLocked(value: string, index: number): boolean {
  return (
    lockedValueSet.value.has(value) &&
    props.modelValue.findIndex((option) => option.value === value) === index
  );
}

function updateOption(index: number, changes: Partial<FieldOptionInput>): void {
  const next = cloneEnumOptions(props.modelValue);
  const current = next[index];
  if (current === undefined) {
    return;
  }
  next[index] = { ...current, ...changes };
  emit('update:modelValue', next);
}

function addOption(): void {
  emit('update:modelValue', [...cloneEnumOptions(props.modelValue), newEnumOption()]);
}

function move(fromIndex: number, toIndex: number): void {
  emit('update:modelValue', moveEnumOption(props.modelValue, fromIndex, toIndex));
}

function startDrag(index: number): void {
  draggedIndex.value = index;
}

function finishDrop(index: number): void {
  if (draggedIndex.value !== null) {
    move(draggedIndex.value, index);
  }
  draggedIndex.value = null;
}
</script>

<template>
  <section class="enum-editor" aria-label="枚举选项编辑器">
    <header class="enum-editor-heading">
      <div>
        <strong>枚举选项</strong>
        <span>{{ modelValue.length }} 项 · 数组顺序即展示顺序</span>
      </div>
      <el-button type="primary" plain @click="addOption">新增选项</el-button>
    </header>

    <el-empty v-if="modelValue.length === 0" description="尚未登记选项">
      <el-button type="primary" @click="addOption">新增第一个选项</el-button>
    </el-empty>

    <div v-else class="option-list">
      <article
        v-for="(option, index) in modelValue"
        :key="`${option.value}:${index}`"
        class="option-row"
        :class="{ 'is-dragging': draggedIndex === index }"
        @dragover.prevent
        @drop="finishDrop(index)"
      >
        <button
          class="drag-handle"
          type="button"
          draggable="true"
          :aria-label="`拖动第 ${index + 1} 个选项排序`"
          @dragstart="startDrag(index)"
          @dragend="draggedIndex = null"
        >
          ⋮⋮
        </button>
        <span class="option-order">{{ String(index + 1).padStart(2, '0') }}</span>
        <el-form-item
          label="选项值"
          required
          :error="validationAttempted ? validation.items[index]?.value : undefined"
        >
          <el-input
            :model-value="option.value"
            :disabled="isValueLocked(option.value, index)"
            placeholder="例如 sms"
            @update:model-value="(value: string) => updateOption(index, { value })"
          />
        </el-form-item>
        <el-form-item
          label="展示名称"
          required
          :error="validationAttempted ? validation.items[index]?.label : undefined"
        >
          <el-input
            :model-value="option.label"
            placeholder="例如 短信验证码"
            @update:model-value="(label: string) => updateOption(index, { label })"
          />
        </el-form-item>
        <el-form-item label="允许新上报" class="status-control">
          <el-switch
            :model-value="option.status === 'active'"
            inline-prompt
            active-text="是"
            inactive-text="否"
            @update:model-value="
              (active: boolean) => updateOption(index, { status: active ? 'active' : 'disabled' })
            "
          />
        </el-form-item>
        <div class="order-buttons" aria-label="排序快捷操作">
          <el-button
            link
            :disabled="index === 0"
            :aria-label="`上移 ${option.value || `第 ${index + 1} 项`}`"
            @click="move(index, index - 1)"
          >
            ↑
          </el-button>
          <el-button
            link
            :disabled="index === modelValue.length - 1"
            :aria-label="`下移 ${option.value || `第 ${index + 1} 项`}`"
            @click="move(index, index + 1)"
          >
            ↓
          </el-button>
        </div>
      </article>
    </div>

    <el-alert
      v-if="validationAttempted && validation.form"
      :title="validation.form"
      type="error"
      :closable="false"
      show-icon
    />
    <p class="enum-editor-note">
      选项值创建后不可修改，也不能删除；不用的选项请停用，历史数据仍保留原展示名称。
    </p>
  </section>
</template>

<style scoped>
.enum-editor {
  display: grid;
  gap: 12px;
  padding: 14px;
  background: #f7faff;
  border: 1px solid #dce8fa;
  border-radius: 10px;
}

.enum-editor-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.enum-editor-heading > div {
  display: grid;
  gap: 3px;
}

.enum-editor-heading span,
.enum-editor-note {
  font-size: 12px;
  color: #778499;
}

.option-list {
  display: grid;
  gap: 8px;
}

.option-row {
  display: grid;
  grid-template-columns: 26px 28px minmax(150px, 1fr) minmax(160px, 1.15fr) 104px 54px;
  align-items: start;
  padding: 12px 10px 0;
  background: #fff;
  border: 1px solid #e1e8f2;
  border-left: 3px solid #79a7e8;
  border-radius: 8px;
  gap: 8px;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.option-row.is-dragging {
  border-color: #409eff;
  box-shadow: 0 6px 18px rgb(64 158 255 / 14%);
}

.drag-handle {
  padding: 7px 2px;
  cursor: grab;
  font-weight: 800;
  letter-spacing: -3px;
  color: #8795aa;
  background: transparent;
  border: 0;
}

.drag-handle:active {
  cursor: grabbing;
}

.drag-handle:focus-visible {
  border-radius: 4px;
  outline: 2px solid #409eff;
  outline-offset: 2px;
}

.option-order {
  padding-top: 8px;
  font:
    700 11px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  color: #7a8ba3;
}

.status-control {
  min-width: 104px;
}

.order-buttons {
  display: flex;
  padding-top: 24px;
}

.order-buttons :deep(.el-button + .el-button) {
  margin-left: 2px;
}

.enum-editor-note {
  margin: 0;
  line-height: 1.55;
}

@media (max-width: 760px) {
  .option-row {
    grid-template-columns: 26px 28px 1fr;
  }

  .option-row :deep(.el-form-item) {
    grid-column: 3;
  }

  .order-buttons {
    grid-column: 3;
    padding: 0 0 10px;
  }
}
</style>
