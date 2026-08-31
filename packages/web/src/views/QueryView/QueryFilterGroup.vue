<script setup lang="ts">
import { computed } from 'vue';

import type { FieldTypesResponse, OperatorArity } from '../../api/field-types.js';
import type { CollectionField } from '../../api/tables.js';
import { MAX_SAFE_FIELD_NUMBER, MIN_SAFE_FIELD_NUMBER } from '../../field-types.logic.js';
import {
  createFilterGroup,
  createFilterRule,
  getFieldType,
  getOperatorArity,
  getOperatorOptions,
  isNumericFieldType,
  pickerDateToTimestamp,
  resetRuleForField,
  setRuleOperator,
  timestampToPickerDate,
  type FilterGroupDraft,
  type FilterRuleDraft,
  type LeafOperator,
} from './query.logic.js';

defineOptions({ name: 'QueryFilterGroup' });

const props = defineProps<{
  group: FilterGroupDraft;
  fields: CollectionField[];
  fieldTypes: FieldTypesResponse;
  timeZone: string;
  depth: number;
  root?: boolean;
}>();

const emit = defineEmits<{
  'update:group': [group: FilterGroupDraft];
  change: [];
  remove: [];
}>();

// 嵌套深度上限来自 field-types 下发的 limits（附录 A），前端不写死。
const maxNestingDepth = computed(() => props.fieldTypes.limits.maxNestingDepth);
const canAddRule = computed(() => props.depth < maxNestingDepth.value);
const canAddGroup = computed(() => props.depth < maxNestingDepth.value - 1);

function notifyChange(): void {
  emit('change');
}

function commitGroup(group: FilterGroupDraft): void {
  emit('update:group', group);
  notifyChange();
}

function replaceCondition(index: number, condition: FilterGroupDraft | FilterRuleDraft): void {
  const conditions = [...props.group.conditions];
  conditions[index] = condition;
  commitGroup({ ...props.group, conditions });
}

function firstRule(): FilterRuleDraft {
  const rule = createFilterRule(props.fields[0]?.key ?? '');
  resetRuleForField(rule, props.fields, props.fieldTypes);
  return rule;
}

function addRule(): void {
  if (!canAddRule.value) {
    return;
  }
  commitGroup({ ...props.group, conditions: [...props.group.conditions, firstRule()] });
}

function addGroup(): void {
  if (!canAddGroup.value) {
    return;
  }
  const group = createFilterGroup('and');
  group.conditions.push(firstRule());
  commitGroup({ ...props.group, conditions: [...props.group.conditions, group] });
}

function removeCondition(index: number): void {
  commitGroup({
    ...props.group,
    conditions: props.group.conditions.filter(
      (_condition, conditionIndex) => conditionIndex !== index,
    ),
  });
}

function handleGroupOperator(value: unknown): void {
  commitGroup({ ...props.group, op: value as 'and' | 'or' });
}

function handleFieldChange(index: number, rule: FilterRuleDraft, value: unknown): void {
  const next = { ...rule, field: String(value) };
  resetRuleForField(next, props.fields, props.fieldTypes);
  replaceCondition(index, next);
}

function selectedField(rule: FilterRuleDraft): CollectionField | undefined {
  return props.fields.find((field) => field.key === rule.field);
}

function ruleOperatorOptions(rule: FilterRuleDraft) {
  return getOperatorOptions(rule.field, props.fields, props.fieldTypes);
}

function ruleArity(rule: FilterRuleDraft): OperatorArity | undefined {
  return getOperatorArity(rule.op, props.fieldTypes);
}

function handleOperator(index: number, rule: FilterRuleDraft, value: unknown): void {
  const field = selectedField(rule);
  if (field === undefined) {
    return;
  }
  const next = { ...rule };
  setRuleOperator(next, value as LeafOperator, field, props.fieldTypes);
  replaceCondition(index, next);
}

function setBooleanValue(index: number, rule: FilterRuleDraft, value: unknown): void {
  if (typeof value === 'boolean') {
    replaceCondition(index, { ...rule, value });
  }
}

function stringValue(rule: FilterRuleDraft): string {
  return typeof rule.value === 'string' ? rule.value : '';
}

function setStringValue(index: number, rule: FilterRuleDraft, value: string): void {
  replaceCondition(index, { ...rule, value });
}

function arrayValue(rule: FilterRuleDraft): string[] {
  return Array.isArray(rule.value) && rule.value.every((value) => typeof value === 'string')
    ? rule.value
    : [];
}

function numberValue(rule: FilterRuleDraft): number | undefined {
  return typeof rule.value === 'number' ? rule.value : undefined;
}

function setNumberValue(index: number, rule: FilterRuleDraft, value: unknown): void {
  const next = { ...rule };
  if (typeof value === 'number') {
    next.value = value;
  } else {
    delete next.value;
  }
  replaceCondition(index, next);
}

function numberArrayValue(rule: FilterRuleDraft): number[] {
  return Array.isArray(rule.value) && rule.value.every((value) => typeof value === 'number')
    ? rule.value
    : [];
}

function addNumberArrayValue(index: number, rule: FilterRuleDraft): void {
  replaceCondition(index, { ...rule, value: [...numberArrayValue(rule), 0] });
}

function setNumberArrayValue(
  index: number,
  rule: FilterRuleDraft,
  valueIndex: number,
  value: unknown,
): void {
  const values = [...numberArrayValue(rule)];
  if (typeof value === 'number') {
    values[valueIndex] = value;
  } else {
    values.splice(valueIndex, 1);
  }
  replaceCondition(index, { ...rule, value: values });
}

function removeNumberArrayValue(index: number, rule: FilterRuleDraft, valueIndex: number): void {
  replaceCondition(index, {
    ...rule,
    value: numberArrayValue(rule).filter((_value, candidateIndex) => candidateIndex !== valueIndex),
  });
}

function setArrayValue(index: number, rule: FilterRuleDraft, value: unknown): void {
  replaceCondition(index, {
    ...rule,
    value: Array.isArray(value) ? value.map(String) : [],
  });
}

function fieldOptions(rule: FilterRuleDraft) {
  return selectedField(rule)?.options ?? [];
}

function dateTimeValue(rule: FilterRuleDraft): Date | undefined {
  return typeof rule.value === 'number'
    ? timestampToPickerDate(rule.value, props.timeZone)
    : undefined;
}

function setDateTimeValue(index: number, rule: FilterRuleDraft, value: unknown): void {
  const next = { ...rule };
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    next.value = pickerDateToTimestamp(value, props.timeZone);
  } else {
    delete next.value;
  }
  replaceCondition(index, next);
}

function numberMinimum(rule: FilterRuleDraft): number | undefined {
  return getFieldType(rule.field, props.fields) === 'integer' ? MIN_SAFE_FIELD_NUMBER : undefined;
}

function numberMaximum(rule: FilterRuleDraft): number | undefined {
  return getFieldType(rule.field, props.fields) === 'integer' ? MAX_SAFE_FIELD_NUMBER : undefined;
}
</script>

<template>
  <section class="filter-group" :class="{ 'filter-group--root': root }">
    <header class="group-heading">
      <div class="group-operator">
        <span>{{ root ? '匹配方式' : `第 ${depth} 层条件组` }}</span>
        <el-radio-group :model-value="group.op" size="small" @change="handleGroupOperator">
          <el-radio-button value="and">全部满足</el-radio-button>
          <el-radio-button value="or">任一满足</el-radio-button>
        </el-radio-group>
      </div>
      <el-button v-if="!root" link type="danger" @click="emit('remove')">删除条件组</el-button>
    </header>

    <div v-if="group.conditions.length === 0" class="empty-filter">
      尚未添加条件；留空时查询整个时间范围。
    </div>

    <div v-for="(condition, index) in group.conditions" :key="condition.id">
      <div v-if="condition.kind === 'rule'" class="filter-rule">
        <span class="rule-index">{{ index + 1 }}</span>
        <el-select
          :model-value="condition.field"
          class="field-select"
          filterable
          placeholder="选择字段"
          @change="handleFieldChange(index, condition, $event)"
        >
          <el-option
            v-for="field in fields"
            :key="field.key"
            :value="field.key"
            :label="`${field.label} · ${field.key}${field.status === 'deprecated' ? '（已废弃）' : ''}`"
          />
        </el-select>

        <el-select
          class="operator-select"
          :model-value="condition.op"
          @change="handleOperator(index, condition, $event)"
        >
          <el-option
            v-for="option in ruleOperatorOptions(condition)"
            :key="option.op"
            :label="option.label"
            :value="option.op"
          />
        </el-select>

        <span v-if="ruleArity(condition) === 'none'" class="value-placeholder"> 无需填写值 </span>

        <template v-else-if="getFieldType(condition.field, fields) === 'enum'">
          <el-select
            v-if="ruleArity(condition) === 'many'"
            class="value-input"
            :model-value="arrayValue(condition)"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="选择一个或多个枚举值"
            @change="setArrayValue(index, condition, $event)"
          >
            <el-option
              v-for="option in fieldOptions(condition)"
              :key="option.value"
              :value="option.value"
              :label="`${option.label} · ${option.value}${option.status === 'disabled' ? '（已停用）' : ''}`"
              :class="{ 'enum-option--disabled': option.status === 'disabled' }"
            />
          </el-select>
          <el-select
            v-else
            class="value-input"
            :model-value="stringValue(condition)"
            filterable
            placeholder="选择枚举值"
            @change="setStringValue(index, condition, String($event))"
          >
            <el-option
              v-for="option in fieldOptions(condition)"
              :key="option.value"
              :value="option.value"
              :label="`${option.label} · ${option.value}${option.status === 'disabled' ? '（已停用）' : ''}`"
              :class="{ 'enum-option--disabled': option.status === 'disabled' }"
            />
          </el-select>
        </template>

        <template v-else-if="getFieldType(condition.field, fields) === 'boolean'">
          <el-radio-group
            :model-value="condition.value"
            @change="setBooleanValue(index, condition, $event)"
          >
            <el-radio-button :value="true">是</el-radio-button>
            <el-radio-button :value="false">否</el-radio-button>
          </el-radio-group>
        </template>

        <template v-else-if="getFieldType(condition.field, fields) === 'datetime'">
          <el-date-picker
            class="value-input"
            type="datetime"
            :model-value="dateTimeValue(condition)"
            format="YYYY-MM-DD HH:mm:ss"
            placeholder="选择业务时间"
            @update:model-value="setDateTimeValue(index, condition, $event)"
          />
        </template>

        <template v-else-if="isNumericFieldType(getFieldType(condition.field, fields))">
          <div v-if="ruleArity(condition) === 'many'" class="number-value-list">
            <div
              v-for="(value, valueIndex) in numberArrayValue(condition)"
              :key="valueIndex"
              class="number-value-item"
            >
              <el-input-number
                class="number-input"
                :model-value="value"
                :min="numberMinimum(condition)"
                :max="numberMaximum(condition)"
                :controls="false"
                placeholder="数字"
                @update:model-value="setNumberArrayValue(index, condition, valueIndex, $event)"
              />
              <el-button
                link
                type="danger"
                @click="removeNumberArrayValue(index, condition, valueIndex)"
              >
                移除
              </el-button>
            </div>
            <el-button link type="primary" @click="addNumberArrayValue(index, condition)">
              + 添加数字
            </el-button>
          </div>
          <el-input-number
            v-else
            class="value-input number-input"
            :model-value="numberValue(condition)"
            :min="numberMinimum(condition)"
            :max="numberMaximum(condition)"
            :controls="false"
            placeholder="条件数字"
            @update:model-value="setNumberValue(index, condition, $event)"
          />
        </template>

        <template v-else>
          <el-select
            v-if="ruleArity(condition) === 'many'"
            class="value-input"
            :model-value="arrayValue(condition)"
            multiple
            filterable
            allow-create
            default-first-option
            collapse-tags
            collapse-tags-tooltip
            placeholder="输入后按回车添加"
            @change="setArrayValue(index, condition, $event)"
          />
          <el-input
            v-else
            class="value-input"
            :model-value="stringValue(condition)"
            placeholder="条件值"
            @update:model-value="setStringValue(index, condition, $event)"
          />
        </template>

        <el-button class="remove-rule" link type="danger" @click="removeCondition(index)">
          删除
        </el-button>
      </div>

      <QueryFilterGroup
        v-else
        :group="condition"
        :fields="fields"
        :field-types="fieldTypes"
        :time-zone="timeZone"
        :depth="depth + 1"
        @update:group="replaceCondition(index, $event)"
        @remove="removeCondition(index)"
      />
    </div>

    <footer class="group-actions">
      <el-button size="small" :disabled="!canAddRule || fields.length === 0" @click="addRule">
        + 添加条件
      </el-button>
      <el-tooltip :disabled="canAddGroup" :content="`嵌套深度上限为 ${maxNestingDepth}`">
        <span>
          <el-button size="small" :disabled="!canAddGroup || fields.length === 0" @click="addGroup">
            + 添加条件组
          </el-button>
        </span>
      </el-tooltip>
    </footer>
  </section>
</template>

<style scoped src="./query-filter-group.css"></style>
