import type { FieldType } from './api/tables.js';
import type { FieldTypeLimits } from './api/field-types.js';

export const MIN_SAFE_FIELD_NUMBER = -Number.MAX_SAFE_INTEGER;
export const MAX_SAFE_FIELD_NUMBER = Number.MAX_SAFE_INTEGER;

export const FIELD_NAME_HELP =
  '字段名只用于管理后台展示，查询结果表头会使用它；可随时修改，不影响物理表。真正的列名和上报键名是“字段 Key”，修改 Key 的代价更大。';

const FIELD_TYPE_NOTICES = {
  enum: '枚举值必须来自字段配置中已启用的选项。',
  boolean: '',
  integer: '大整数 ID（雪花 ID、订单号）请用文本类型，超过 2^53 的整数在浏览器里就已经不准了。',
  float: '小数不支持等值筛选，只能按范围过滤。',
  datetime: '使用 Unix 毫秒时间戳表示业务时间。',
} as const satisfies Record<Exclude<FieldType, 'string'>, string>;

export const FIELD_TYPE_DESCRIPTIONS = {
  string: '自由文本、URL、外部 ID 或高基数标识',
  enum: '渠道、结果、状态等有限且受控的值域',
  boolean: '只有是 / 否两种取值',
  integer: '次数、状态码、金额（分）或时长（毫秒）',
  float: '比率、评分等带小数的连续度量',
  datetime: '业务时间，使用 Unix 毫秒时间戳上报',
} as const satisfies Record<FieldType, string>;

export function getFieldTypeNotice(
  type: FieldType,
  limits?: Pick<FieldTypeLimits, 'maxStringLength'>,
): string {
  if (type === 'string') {
    return limits === undefined
      ? '单个字符串值的 UTF-8 字节上限由服务端配置。'
      : `单个字符串值最多 ${limits.maxStringLength} UTF-8 字节，超出会被拒收。`;
  }
  return FIELD_TYPE_NOTICES[type];
}

export function isSafeFieldNumber(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_SAFE_FIELD_NUMBER
  );
}
