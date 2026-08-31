# TODO — 设计实现进度

对照 [`design/`](./design/)（**V4.0 设计稿**）与当前代码逐节盘点。
`design/` 是唯一事实来源，本文件只记录进度。

> **进度**：阶段 A、B、C、D 全部完成并验收通过（A-0 SQLite 迁移 / A-1 表级管理 / A-2 字段变更 /
> B-1 启动期 reconcile / B-2 删表与建表模板 / C 上报接口 / D 查询、统计与导出），
> 并完成 V3.1 标识符收敛（砍掉 `tableId`，全系统只有一个公开 ID `projectId`）。
> 元数据在 SQLite、采集数据在 ClickHouse，持久化收敛到单一 `DATA_DIR`（3.3）。
> **服务端 API 全部完工，当前在做阶段 E（管理后台前端），E-1 / E-2 / E-3 / E-4a 与
> `number` 字段类型批次已验收。**
>
> **2026-08-30：`design/` 升到 V4.0，重做了字段类型系统与统计模型（见 `design/01` 的 V4.0 条目）。
> 因此插入「阶段 V4」，它挡在 E-4b 前面——统计分析页要按新的 `dimension` × `measure` 接口做，
> 先按旧 `metric` 做一遍纯属返工。当前实现的单一 `number` 类型是过渡态，本阶段拆成
> `integer` / `float`。**
>
> **当前基线**（验收对比用）：32 条路由、**40 个错误码**；`pnpm -r typecheck / lint / test` 全绿——
> 服务端 **31 files / 217 tests**，web 10 files / 82 tests；web `build` 通过。
> （`number` 批次重新动了服务端，计数因此高于 D 阶段；V4-1 +1 file / +5 tests、+1 错误码；
> V4-3 +10 tests、无新增文件。**上一版这里把服务端测试文件数误记成 32，实际是 31**——
> `git ls-tree HEAD` 比对确认从未有测试文件被删，勿据旧数字判定 codex 删了文件。）
> **`prettier --check` 当前红**，唯一不合规文件是 `packages/web/src/components/v-dialog.vue`，
> 与 V4 无关，跑一次 `pnpm format` 即可。
>
> 2026-08-28 废弃 `POST .../fields/:fieldKey/retype` 后路由 33→32、服务端 tests 179→178。
>
> 2026-08-29 本地开发环境改定（已写进 `AGENTS.md`，并新增只有一行 `@AGENTS.md` 的 `CLAUDE.md`）：
> **开发阶段不起 docker**，ClickHouse 直接跑在宿主机；`DATA_DIR` 从 `/tmp/collect-log-data`
> 迁到**仓库根目录下的 `data/`**（`data/sqlite3` + `data/clickhouse` + `data/ch-config`，
> 已加进 `.gitignore` 与 `.prettierignore`）。容器化仍留在阶段 G。
>
> 2026-08-29 拍板「放开删列 + 让废弃字段可查」后服务端 tests 181→184（`deprecated` 字段可物理删除、
> `query` / `export` 新增 `includeFields`），详见「二、验收遗留 → 来自阶段 E-3」。
>
> 已完成事项与各阶段验收过程记录已于 2026-08-28 清理；**仍然生效的拍板规则保留在第二节**。
> 设计稿同日按章节从单文件 `DESIGN.md` 拆分到 `design/`，内容逐字未改，章节号不变。

---

## 一、未完成

### 阶段 V4：类型系统与统计模型重做（design V4.0，2026-08-30 定稿）

DESIGN 5.4 / 5.5 / 6.4.1 / 6.6 / 7.2 / 7.3 / 7.4 / 8.2.1 / 9.3 / 9.4 / 10.3 / 10.6 / 15.4 / 15.8

**这是 V3 以来第一次改业务语义**，覆盖建表、上报、查询、统计与后台五处。四条主线：
字段类型 2 种 → 6 种；能力由类型反推并由服务端下发；统计从枚举 `metric` 换成两轴模型；
新增枚举选项表与 `string` ⇄ `enum` 无损转换。**新增唯一错误码 `INVALID_FIELD_VALUE`（400）。**

**批次划分已于 2026-08-30 重排。** 原计划 V4-1…V4-5 是按「层」横切的（先做完所有服务端，
再做前端 V4-5），V4-1 验收时就暴露了后果：单个批次落地后系统并不可用（枚举形同 `string`）。
更糟的是 V4-4 若单独落地，web 那两张硬编码操作符表既是下拉数据源又是提交前校验
（`query.logic.ts:48,59` 定义、`361,386` 使用），会继续放行服务端已拒绝的组合——
前端自校验通过、服务端拒收，是用户可见的损坏，比 V4-1 少一道校验严重。

因此已完成的 V4-1 / V4-3 保持原样（都是纯服务端、无前端对应物，本就自洽），
**剩余部分按功能纵切成三批，每批服务端 + 前端一起做完，落地即可用**：

| 批次                        | 内容                                                                                                     | 由原计划的哪些条目组成                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **V4-β** 枚举选项与类型转换 | 选项 diff 路由、`string` ⇄ `enum` 转换、reconcile 漂移检查 + 后台选项编辑器与转换入口                    | 原 V4-2 全部 + 原 V4-5 前两条            |
| **V4-γ** 能力矩阵与过滤     | 能力矩阵模块、`field-types` 接口、`filter.ts` 重写、`lt`/`lte` 修复、输出编码 + 查询构建器改为按接口渲染 | 原 V4-4 第 1/2/3/5/6 条 + 原 V4-5 第三条 |
| **V4-δ** 统计两轴模型       | `dimension` × `measure` 重写 + 统计分析页（E-4b）                                                        | 原 V4-4 第 4 条 + 原 V4-5 第四条         |

顺序 V4-β → V4-γ → V4-δ，每批各自保证三件套全绿。

**V4-1 元数据与建表（server）**

- [x] `FIELD_TYPES` 扩到六种；物理类型映射按 6.6：`enum` → `LowCardinality(Nullable(String))`、
      `integer` → `Nullable(Int64)`、`float` → `Nullable(Float64)`、
      `datetime` → `Nullable(DateTime64(3, 'UTC'))`
- [x] `collect_fields.type` 的 `CHECK` 改写 —— **又一次老库迁移**，沿用 `number` 批次那套
      （读 `sqlite_schema` 比对 CHECK 原文 → 建迁移表 → 全量搬运含墓碑 → DROP → RENAME，
      全程 `BEGIN IMMEDIATE`，幂等），已验证可用，不要另起炉灶
- [x] 新建 `collect_field_options` 表（6.4.1），`(project_id, field_key)` 外键
      `ON DELETE CASCADE`；**上线前确认 `PRAGMA foreign_keys = ON` 真的生效**，
      否则 7.2 那条「墓碑清理连选项一起清」会静默失效，重建的同名字段会继承一批幽灵选项
- [x] 建表与新增字段接受 `options`：`enum` 必须带至少一个 `active` 选项，其余类型必须不带，
      违反回 `INVALID_FIELD_VALUE`
- [x] 表结构缓存值加入「各 `enum` 字段的 active 选项集合」（13），选项变更走同一条失效路径
- [x] 新增错误码 `INVALID_FIELD_VALUE`（400）：`errors.ts` + web 侧文案映射（错误码 39 → 40）

> **V4-1 已验收通过（2026-08-30）。** 迁移函数同时吃掉 V3.1（`string` / `boolean`）与 `number`
> 两代老库，`number` 就地映射成 `float`；物理列类型由集成测试查 `system.columns` 逐个比对；
> 选项级联删除由一条真删数据的测试守住（顺带断言 `PRAGMA foreign_keys` 确实是 1）。
> **以下三处是按指令有意留给后续子阶段的中间态，不是遗漏**：上报侧对 `enum` 值域完全不校验、
> `integer` 收到小数仍回 `INVALID_FIELD_TYPE`（应为 `INVALID_FIELD_VALUE`）、`datetime` 无窗口
> 校验 → 全在 V4-3（已完成）；`filter.ts` 仍给 `float` / `datetime` 发 `eq` / `in`、
> 给 `enum` 发 `contains`，web 仍硬编码两张操作符表 → 都归入重排后的 V4-γ。
> **因此 V4-1 单独上线是不完整的，枚举此刻形同 `string`**——正是这一条促成了后面的批次重排。

**V4-3 上报校验（server）**

- [x] 按 8.2.1 把校验拆成「第 10 步类型 / 第 11 步值域」两步，错误码分别是
      `INVALID_FIELD_TYPE` / `INVALID_FIELD_VALUE`。**不要合并**，两者的修法完全不同
- [x] 六种类型的值域规则：`enum` 命中 active 选项、`integer` 判 `Number.isInteger` 且 ≤ 2^53-1、
      `float` 判 `Number.isFinite`、`datetime` 判整数毫秒且落在窗口内
- [x] `error.expected.options`（仅 `enum`，**不含已停用选项**）
- [x] 附录 A 新增 `datetimeMinMs` / `datetimeMaxMs` / `maxEnumOptions` /
      `maxOptionValueBytes` / `maxOptionLabelBytes` / `defaultGroupLimit` / `maxGroupLimit`
- [x] **补上 V4-1 欠的三道选项闸**：`schema.ts` 的 `validateFieldOptions` 目前把选项 value
      的 64 字节上限**硬编码**成字面量，且完全没有校验 `maxEnumOptions`（200）与
      `maxOptionLabelBytes`（128）。这三处一并改成读 `limits.schema.*`

> **V4-3 已验收通过（2026-08-30）。** `limits.ts` 与附录 A 的代码块 `diff` 结果为零差异（铁律 4）；
> 8.2.1 那张六类型两步表逐行核对一致；`expected.options` 由一条端到端测试守住——建表时登记
> `sms` / `password` / `legacy(disabled)`，上报 `legacy` 断言回 `INVALID_FIELD_VALUE` 且
> `options` 只有 `['sms','password']`。测试文件逐个比对 HEAD **只增不减**
> （validate 9→16、ingest.integration 9→12、schema 6→8、limits 2→3、fields.integration 9→13）。
>
> 改过的旧断言有三处，都是把 V4-1 的过渡行为纠正到 8.2.1：`float` 超出安全整数范围
> 从「拒收」改为「合法」（值域只判 `Number.isFinite`）、`NaN` / `±Infinity` 从
> `INVALID_FIELD_TYPE` 改判 `INVALID_FIELD_VALUE`（`typeof` 是 `number`，形状没错、取值不合法）。
> 这不是放松测试。
>
> 一处已知小缺口，**不影响正确性，留给谁都行**：`expected.options` 被 `maxEnumOptions` 截断时，
> 只有 `enum` 的 `INVALID_FIELD_VALUE` 分支会在 `message` 里补「还有多少个」，
> `REQUIRED_FIELD_MISSING` / `INVALID_FIELD_TYPE` / `FIELD_VALUE_TOO_LONG` / `DEPRECATED_FIELD`
> 四条携带 `expected` 的路径没有。仅在把 `LIMIT_SCHEMA_MAX_ENUM_OPTIONS` 调到低于存量选项数时可触发。

**V4-β 枚举选项与类型转换（server + web，端到端）**

> **先读这条再动 `bootstrap/schema.ts`。** V4-1 那套 `collect_fields` 重建迁移
> （建新表 → 搬运 → `DROP TABLE` → `RENAME`）现在**只是碰巧安全**：它跑在
> `collect_field_options` 建表之前，所以 `DROP` 时没有子表。一旦以后再加一次
> `collect_fields` 重建，`PRAGMA foreign_keys = ON` 会让 `DROP TABLE` 触发
> `ON DELETE CASCADE`，**把所有库里的枚举选项静默清空**，而且事务照常提交、日志一切正常。
> 已实测确认（1 行子表数据在重建后变 0 行）。再加重建时必须先 `PRAGMA foreign_keys = OFF`
> （pragma 在事务内无效，要放在 `BEGIN` 之外），收尾再打开——即 SQLite 官方那套表重建步骤。

- [x] `PUT .../fields/:fieldKey/options`：全量 diff，**现存 `value` 缺一即整体失败**（7.3 第 3 条）；
      版本规则按 5.3（新增或改 `status` 才加一，只改 `label` / 顺序不加）
- [x] `POST .../fields/:fieldKey/retype`：只接受 `string → enum` / `enum → string`，
      走 `serial()`，`MODIFY COLUMN` **不设 `mutations_sync`**，其余方向回 `INVALID_FIELD_TYPE`
- [x] 表详情与字段变更响应的 `field` 增加 `options`（含已停用，按 `sort_order`）
- [x] 7.4 reconcile 增加**物理类型漂移检查**：只自动收敛 `String` ⇄ `LowCardinality(String)`，
      其余不一致只写告警日志
- [x] 路由 32 → 34
- [x] **web**：字段配置的六类型下拉 + 类型提示文案（`integer` 的大整数警告、
      `float` 的不可等值警告）、选项编辑器（增 / 改 label / 停用 / 拖拽排序，**没有删除**）
- [x] **web**：`string` ⇄ `enum` 转换入口；`string → enum` 弹窗先拉该字段 Top 值供一键登记（10.3）

> **V4-β 验收通过（2026-08-30）。** 四件套我自己跑过：typecheck / lint / build 全绿，
> server 31 files / 222 tests、web 11 files / 89 tests 全过。`design/` 与 `AGENTS.md`
> 按 mtime 确认零改动。核对过的实质点：全量 diff 缺项整体失败、`label` / 顺序变更不提版本、
> retype 只放行 `string` ⇄ `enum` 且 DDL 前置校验、reconcile 只在
> `{Nullable(String), LowCardinality(Nullable(String))}` 集合内收敛、其余不一致仅告警不改表；
> 新的 `options` / `retype` 两条路由都进了 15.4 的 403 用例。
> 测试只增不减（reconcile 16→18、validate 10→17、fields 9→16、ingest 11→14、schema 6→8、
> limits 2→3、tables.logic 8→9），`query.logic.test.ts` 只加了一个 `options: []` 夹具，
> `query.logic.ts` 本体未动，V4-γ 的边界守住了。
>
> 遗留两条，都不阻断：
>
> 1. `web/src/field-types.logic.ts:10` 把 `4096` 写死进提示文案，而附录 A 里
>    `LIMIT_INGEST_MAX_STRING_LENGTH` 是可配的——改了环境变量提示就会骗人。
> 2. `retypeField` 先做 ClickHouse DDL 再开 SQLite 事务，中途失败没有像 `renameField`
>    那样回滚物理列。靠上面那条 reconcile 漂移收敛自愈；因为这一对物理类型收同样的值域，
>    漂移期间上报与查询都不受影响，属于「已知且已覆盖」，不是缺陷。
>
> `TableDetailView.vue` 已经 2134 行，打包产物 1.11 MB（超 500 kB 警告），记作技术债。

**V4-γ 能力矩阵与过滤（server + web，端到端）**

> **这一批的服务端与前端必须同批落地。** `filter.ts` 收紧操作符的同时，web 那两张硬编码表
> （`query.logic.ts:48` `STRING_OPERATOR_OPTIONS` / `:59` `NUMERIC_OPERATOR_OPTIONS`）
> 必须删掉改成读 `field-types`——它们在 `:361` `:386` 还兼任提交前校验，
> 只改服务端会让前端放行已被拒绝的组合，是用户可见的损坏。

- [x] **能力矩阵做成单一模块**（5.4.2 那张表），`filter` / `statistics` / `field-types`
      三处共用同一份数据。这是整个 V4 的关键实现约束——一旦抄成三份就前功尽弃
- [x] `filter.ts` 按能力重写：`float` 去掉 `eq` / `in`，`boolean` 去掉 `in`，
      `datetime` 只留范围，新增 `is_empty` / `is_not_empty`
- [x] **修 `lt` / `lte` 误包 `NULL` 的 bug**（见「二、来自 `number` 字段类型批次」），
      连带改 `query.test.ts:155,160` 与 `query.integration.test.ts:253-261` 的断言
      —— 那两处已经把错误行为固化成预期，不改就会挡住正确实现。
      注意 V4-1 把这个错误行为**一并复制给了新的三种数值类型**，修的范围比原计划大
- [x] 输出编码（9.1）：`output_format_json_quote_64bit_integers = 0`；
      `datetime` 与系统时间列一律 ISO 8601 UTC 字符串
- [x] 新增 `GET /api/admin/field-types`（15.8），下发能力矩阵 + 已推导好的 operators / measures
- [x] **web**：查询构建器改为按 `field-types` 渲染，删掉前端现有的硬编码操作符表（10.6）

> **V4-γ 已验收通过（2026-08-30）。** 中断时留下的 8 个失败断言已按 5.4.2 / 9.3
> 纠正：`float` 不再接受 `eq` / `neq` / `in` / `not_in`，`lt` / `lte` 不再包含 `NULL`；
> `statistics` 的既有 `unique` / `group` 能力判断与 `filter` / `field-types` 共用
> `domain/field-types.ts`。查询、统计、导出统一显式设置
> `output_format_json_quote_64bit_integers = 0` 与 ISO 时间输出。
>
> web 启动后单次缓存 `GET /api/admin/field-types`，查询构建器的操作符渲染与提交前校验
> 都读取接口数据；原 `STRING_OPERATOR_OPTIONS` / `NUMERIC_OPERATOR_OPTIONS` 已删除，
> 六类型值控件按 10.6 落地。字符串长度提示读取接口下发的 `maxStringLength`，不再写死 4096。
>
> 四件套全绿：server 32 files / 225 tests、web 12 files / 90 tests；typecheck / lint / build 通过。
> `measuresForFieldType` 不下发 `count` 是有意设计：`count` 是不带 `field` 的表级度量，
> 带了 `field` 要返回 `INVALID_QUERY`；`is_null` / `is_not_null` 则对六种类型无条件可用，
> 因此两处过滤条件本就应当不对称（依据在 9.4.2 与 5.4.2 末尾，不在 5.4.2 的表里）。
>
> **验收核对（我独立重跑，非采信报告）：** 四件套亲自跑过，数字与上一致。`CAPABILITIES_BY_TYPE`
> 与 5.4.2 那张表逐格比对，六类型 × 八能力完全一致；`buildLeaf` 生成的 SQL 与 9.3 的表逐行
> 对得上，包括 `is_not_empty` 是唯一不包 `NULL` 的否定形。全仓搜不到
> `STRING_OPERATOR_OPTIONS` / `NUMERIC_OPERATOR_OPTIONS` 残留，web 生产代码里没有能力表的
> 影子副本（只剩 `api/field-types.ts` 的类型声明）。`buildQueryFilter` 在矩阵未加载时**失败关闭**
> 而不是放行。`QUERY_OUTPUT_SETTINGS` 挂在明细 / 统计 / 导出计数 / CSV 流 / row-count 五处，
> 且是 query-level 而非 client 默认。集成测试无运行时跳过，`score <= 10` 实测回 `[10, 0]`、
> `float in` 实测回 400，是真打了本机 ClickHouse。无 `.skip` / `.only` / `.todo`，无文件删除，
> `design/` 与 `AGENTS.md` mtime 零改动。V4-δ 的复选框仍未勾，统计接口仍是 `metric` 形状，边界守住了。
>
> **遗留（非阻断，并入 V4-δ）：** `query.logic.ts:11-12` 的 `QUERY_MAX_CONDITIONS = 32` 与
> `QUERY_MAX_NESTING_DEPTH = 4` 仍写死在 web，而附录 A 里 `maxConditions` / `maxNestingDepth`
> 是可配的，`GET /api/admin/field-types` 的 `limits` 也没下发这两项。与这批刚修掉的 `4096`
> 是同一类问题：配置调大后前端会拦下服务端本可接受的条件。今天默认值一致，暂不影响使用。

**V4-δ 统计两轴模型（server + web，端到端）**

- [x] `statistics` 从 `metric` 换成 `dimension` × `measure`（9.4）：
      `WITH TOTALS` 拿总计、`WITH FILL` 补空桶（**仅 `axis = _occurred_at` 时**）、
      始终带 `rows` 列（用于把填充桶的 `avg` / 分位数改写成 `null`）、
      `others` 只在 `count` / `sum` 时给、业务时间轴补 `IS NOT NULL` 并返回 `nullAxisRows`
- [x] **web**：E-4b 的统计分析页直接按两轴模型做

**已知的连带影响**：`statistics` 换形状对 web 冲击很小——E-4a 只做了明细查询，
统计分析页还没写，所以这次换接口没有存量页面要改。这是把 V4 排在 E-4b 之前的主要理由，
也是 V4-δ 可以放在最后的理由：它没有存量前端要拆。

> **V4-δ 已完成（2026-08-30）。** `statistics` 现在只有两个轴：`parse.ts` 收
> `{ range, tz, dimension?, measure, filter? }`，`sql.ts` 按 9.4.3 生成三条语句，
> `routes.ts` 按 9.4.4 组装响应。`metric` / `granularity` / `field` / `limit` 四个顶层入参、
> 以及 `total` / `trend` / `unique` / `group` / `boolean_ratio` 五个枚举值全部消失。
> 能力判断仍然只有一份：新增的 `fieldTypeSupportsMeasure` / `measureRequiresField` 都建在
> `domain/field-types.ts` 的 `MEASURE_DEFINITIONS` 上，`sql.ts` 只保留 fn → 聚合表达式的映射。
>
> **两处对 9.4.3 片段的补充，都写在代码注释里：**
>
> 1. **时间维度也带 `WITH TOTALS`。** 9.4.3 的时间维度片段没有它，但 9.4.4 的响应形状里
>    `totals` 是必有项、10.6 又要求结果区把它显示出来，而 `avg` / 分位数的总计无法由各桶推出。
>    实测 `GROUP BY ... WITH TOTALS` 与 `ORDER BY ... WITH FILL` 可以共存。
> 2. **`nullAxisRows` 用第二条查询取。** 主查询已被 `axis IS NOT NULL` 过滤，`WITH TOTALS`
>    拿不到被排除的那部分。9.4.3 第一条反对的是「用第二条查询算分组占比的分母」，不是这个。
>
> **统计走 `FORMAT JSON` 而不是 `JSONEachRow`**：逐行格式不输出 `WITH TOTALS` 的总计行。
>
> 空桶改写按 9.4.3 第三条 + 17.3：`rows = 0` 时 `count` / `sum` 归 `0`、
> `avg` / `min` / `max` / `p50` / `p90` / `p99` 归 `null`；**`unique` 归 `0`** ——
> 空桶里「0 个不同取值」本来就是对的，属于第三条那句「对 count / sum 恰好正确」的同一类。
>
> web 侧新增 `views/StatisticsView/`（`.vue` + `statistics.logic.ts` + 单测），
> 两个轴的下拉、字段列表按能力过滤、`string` 维度的高基数提示、结果区的
> `totals` / `truncated` / `others` / `nullAxisRows`、`avg` 与分位数旁的分母口径都按 10.6 落地。
> 图表用 ECharts（按需注册 line / bar），路由改成动态 import 单独切 chunk，
> 主包因此仍是 1.12 MB，没有为统计页买单。筛选区直接复用 `QueryView/QueryFilterGroup.vue`。
>
> **顺带修掉 V4-γ 的遗留**：`field-types` 的 `limits` 增加 `maxConditions` /
> `maxNestingDepth` / `maxRangeDays` / `defaultGroupLimit` / `maxGroupLimit`，
> `query.logic.ts` 的三个前端常量与 `QueryFilterGroup.vue` 的深度上限全部改成读接口，
> `QUERY_MAX_RANGE_DAYS` / `QUERY_MAX_CONDITIONS` / `QUERY_MAX_NESTING_DEPTH` 已删除。
> `maxRangeDays` 是同一类问题（`92` 也写死在 `validateTimeRange` 里），一并修了。
>
> 四件套全绿：server 32 files / 233 tests、web 13 files / 101 tests，
> typecheck / lint / build 通过。集成测试打本机 ClickHouse，无 `.skip` / `.only` / `.todo`。
> `design/` 与 `AGENTS.md` mtime 零改动。
>
> **验收核对（我独立重跑，非采信报告）：** 四件套亲自跑过，数字一致。`buildStatisticsStatement`
> 三条语句对着 9.4.3 逐行比过：无维度与字段维度**逐字一致**（含 `GROUP BY key WITH TOTALS`
> / `ORDER BY value DESC, key ASC` / `LIMIT {group_limit:UInt32}` 与 `limit + 1` 截断探测），
> 时间维度只多出上面点名的 `WITH TOTALS`。`WITH FILL` 确实只在 `axis.occurredAt` 为真时拼上，
> 业务轴走 `IS NOT NULL` + 独立的 `buildNullAxisRowsStatement`。响应组装对着 9.4.4
> 逐条比过：`share` 仅 `count`、`others` 仅字段维度且 `fn ∈ {count, sum}`、无维度时
> `rows` 单元素无 `key` 且 `dimension` 为 `null`。
>
> **注入面**：物理表名走 `assertIdentifier`，列名走 `requireStatisticsField` → `assertValidFieldKey`
> 白名单，粒度 / 聚合函数都是以联合类型为键的查表，`tz` / `start` / `end` / `group_limit`
> 全部参数化。没有任何用户输入被拼进 SQL。9.1 的 `QUERY_OUTPUT_SETTINGS` 在改走
> `FORMAT JSON` 之后仍挂在统计路径上。
>
> **`key: null` 那一档**由三处集成断言正面守住（布尔字段三档、`note` 四行、`user_id` 四档），
> 是真打 ClickHouse 出来的结果，不是构造的。删掉的 `boolean_ratio` 两个用例确实被
> 「boolean 字段维度 + `count`」覆盖且断言了 `share` 之和为 1 —— 这正是 9.4.4 明写的替代方式，
> 属替换不属削弱。测试只增不减：`query.test` 24→30、`query.integration` 8→10，
> 新增 `statistics.logic.test` 11 例，无文件删除。
>
> **单一来源仍然成立**：web 生产代码里搜不到「类型 → 能力 / 指标」表，`statistics.logic.ts`
> 的维度、时间轴、指标字段三处过滤全部读 `stores/field-types.ts` 的接口数据，
> 连「哪个 `fn` 需要字段」都是从「`count` 在顶层 `measures` 里、却不在任何类型的 `measures` 中」
> 推出来的。矩阵未加载时一律返回空选项，失败关闭。
>
> **边界守住**：`/overview`（10.2 数据概览）与 `/accounts`（E-5）仍是 `PlaceholderView`。
>
> **发现的设计问题（按铁律 1 只记录、不改 `design/`），共四处，都在 9.4：**
>
> 1. **9.4.4 的 `totals` 只出现在示例 JSON 里，没进条目列表**，而 9.4.3 的时间维度片段又没有
>    `WITH TOTALS` —— 逐字实现的话时间维度产不出 `totals`，与 10.6「结果区必须展示 totals」冲突。
>    建议把 `totals` 补进 9.4.4 条目、并给 9.4.3 的时间维度片段加上 `WITH TOTALS`。
> 2. **9.4.3 第三条说 `WITH FILL` 填的默认值「对 `count` / `sum` 恰好正确」与实测不符**：
>    `sum` 作用在 `Nullable(Float64)` 上时空桶拿到的是 `NULL` 而非 `0`。所以服务端必须双向归一化，
>    而不是只做「把 `avg` / 分位数改成 `null`」那一半。
> 3. **`unique` 的空桶取值 9.4.3 没点名**，实现按 `0` 处理。
> 4. **9.4.4 没说无维度时给不给 `share`**，实现按字面「仅 `fn = count` 时给出」照给，
>    于是不分组 + `count` 那一行带 `share: 1`。

### 阶段 E：管理后台前端

DESIGN 10.1–10.5 / 9.2 / 11.3

**E-1 已完成并验收通过**（2026-08-28）：API 客户端与错误码映射、auth / timezone store、
权限矩阵、路由守卫、登录页、应用外壳（侧边栏按角色过滤 + 时区选择器 + 修改密码 + 登出）、
dev proxy。后续页面暂用 `PlaceholderView` 占位。web 侧新增 4 files / 33 tests。

**E-2 已完成并验收通过**（2026-08-28）：表列表页（客户端搜索 / 状态筛选 / 排序 / 空态、
状态标签覆盖五种状态、创建时间按全局时区格式化、行内只有「查看详情」入口）、创建表弹窗
（字段增删、Key 与名称校验、字段数上限交服务端）、10.5 模板下拉与回填（状态标注、覆盖确认、
不回填表名、无 `templateFrom`）。新增 `api/tables.ts` / `views/TablesView.vue` /
`views/tables.logic.ts` + 单测，路由新增 `/tables/:projectId` 仍用 `PlaceholderView` 占位。
web 侧新增 1 file / 8 tests（累计 5 files / 41 tests）。

**E-3 已完成并验收通过**（2026-08-29）：表详情页 `TableDetailView.vue`（三个 tab：基本信息与状态 /
字段配置 / 接入文档，**不新增路由**）+ `table-detail.logic.ts` 纯逻辑与单测。覆盖 5.1 状态迁移
（`failed → creating` 走 `retry`，`creating` 无手动入口）、停用与归档一级确认、字段新增 / 编辑 /
改名 / 软废弃、字段物理删除与删表的两级确认（10.4 全部要求）、密钥查看与轮换、逐字取自 8.1.3 的
接入文档（已按字节比对确认与 `design/08` 一致）。web 侧新增 1 file / 11 tests（累计 6 files / 52 tests）。

**E-4a 已完成并验收通过**（2026-08-29）：`views/` 重组为「一个页面一个文件夹」（纯 `git mv`）、
`api/query.ts` 查询客户端、数据明细查询页 `QueryView/`（选表 + URL 同步 + 条件构造器 +
游标分页 + 列顺序/显隐记忆 + CSV 导出）、表详情页的「最近上报记录」、
`detail-rows.ts` 两页共用的单元格渲染。收尾批另做了流式导出改造与时区选择删除
（见「二、来自阶段 E-4a」）。web 侧 6 files / 52 tests → **9 files / 78 tests**，服务端零改动。

剩余子阶段：E-4b 数据概览·统计分析／E-5 账户管理。

- [ ] 数据概览（今日总量按用户时区、最近 24 小时趋势、各表上报量、最近上报时间；**不做失败数量卡片**）
      —— 已拍板走**前端逐表聚合、不动服务端**，需客户端限流（`query.maxConcurrent` 只有 8，
      N 张表 × 3 个请求会自己把闸打满），并发不超过 4。
- [x] 数据明细查询（条件构造器 + 游标分页 + 结果表格支持拖动列顺序/隐藏列/显示列，
      纯前端本地状态，不落后端，见 DESIGN 9.1）—— E-4a 完成
- [x] 统计分析（ECharts 图表）—— V4-δ 完成（两轴模型，见上）
- [ ] 账户管理
- [x] 表详情页的「最近上报记录」（10.3）—— E-4a 完成（最近 7 天 / `limit=20` / `order=desc` / 不带 filter）

**`number` 字段类型 + 数值范围过滤已完成并验收通过（2026-08-30）**：规则见 `AGENTS.md`
「对 DESIGN 的授权补充」第 3、4 条。**这是过渡态**——`design/` 已于同日定稿为六种类型
（V4.0），单一 `number` 与 `lt` / `lte` 的 NULL 语义 bug 都在「阶段 V4」里重构掉。

**E-4b 必须排在阶段 V4 之后**：统计分析页要按 9.4 的 `dimension` × `measure` 做，
按旧 `metric` 先做一遍是纯返工。数据概览页（前端逐表聚合、并发不超过 4）不依赖新模型，
可以先做。

### 阶段 F：验收测试

DESIGN 17.1–17.5

- [ ] 17.1 创建与变更全流程
      （删表相关的三条——`active` / `disabled` / `creating` 拒绝删除、`super_admin` 输名删除后
      物理表·元数据·墓碑全清而 `admin` 得 `FORBIDDEN`、`DROP` 后崩溃可重删收尾且 reconcile 出告警——
      以及模板相关的两条，**B-2 已按端到端集成测试覆盖**，见 `tables-delete.integration.test.ts`、
      `templates.integration.test.ts`；本阶段只需复核，不必重写）
- [ ] 17.2 上报（签名正确/错误/过期/重放、字段各类错误、`occurredAt` 越界、`sendBeacon` 跨域无预检）
      （**阶段 C 已按端到端集成测试覆盖绝大部分**，见 `src/domain/ingest/ingest.integration.test.ts`：
      合法写入 + 读回断言完整列集合、`INVALID_SIGNATURE` / `SIGNATURE_EXPIRED` / `REPLAYED_NONCE`、
      旧密钥灰度期内可用·过期后被拒、五类字段错误的 `field` + `expected` + `schemaVersion`、
      `occurredAt` 双向越界、四种表状态映射、Origin 白名单、`p` 与 URL 不符。
      **本阶段只需补三条**：端到端的 `RATE_LIMITED` / `TOO_MANY_FIELDS` / `PAYLOAD_TOO_LARGE`
      ——这三条目前只有单元层覆盖）
- [ ] 17.3 查询（组合筛选、时区正确性、拒绝任意 SQL/未注册字段名、CSV 截断标记）
      （**阶段 D 已按端到端集成测试覆盖绝大部分**，见 `src/domain/query/query.integration.test.ts`：
      `and` 嵌套 + `contains` + 布尔 `eq` 的组合筛选、`neq` 对 NULL 与空串的区分、
      天粒度分桶随 `tz` 变化（UTC 1 桶 vs `Asia/Shanghai` 2 桶）、五个 metric、
      游标分页翻完不重不漏、指纹不匹配被拒、CSV 流式导出与截断标记、表状态与角色权限。
      未注册字段名与嵌套/条数超限在 `query.test.ts` 单测覆盖。
      **本阶段只需补两条**：端到端的 `RATE_LIMITED`（并发闸打满）与
      上报路径的 `CLICKHOUSE_UNAVAILABLE` / `INSERT_FAILED` 分支）
- [ ] 17.4 账户（已有 `accounts.integration.test.ts` 覆盖大部分，需补齐验证码不可复用等）
- [ ] 17.5 并发与恢复负向用例（**当前完全缺失**）：
  - [ ] 同一 `recordId` 重试多次，merge 后只剩一行
        （**阶段 C 查明现在测不了**：确定性验证需要 `OPTIMIZE TABLE ... FINAL`，
        而 `ch_meta` 只被授予了 `data` 库的 SELECT/ALTER/CREATE/DROP，**没有 OPTIMIZE**；
        查询又一律不加 `FINAL`（DESIGN 6.5）。要么给 `ch_meta` 补 `OPTIMIZE data` 授权，
        要么改成只断言「两次重试都写入成功且 `_record_id` 相同」。届时一并决定，
        授权改动要同步进阶段 G 的 `sql/` 脚本）
  - [ ] 「物理表已建、`active` 未写」之间 kill 进程，重启 reconcile 收敛为 `active`
  - [ ] 手删已注册列，重启 reconcile 自动补回并记日志

### 阶段 G：部署与运维脚本（2026-08-27 项目负责人提出，**全部功能阶段完工后再做**）

目标形态：

- `sql/` 目录存放建表 SQL 文件
- `sql.sh` 一键创建所有表
- `docker.sh` 一键起 docker
- 所有环境变量走 `.env`，仓库里只提交 `example.env` 作为模板
- 提供 `Dockerfile` 与 `docker-compose.yml`

待办：

- [ ] 新建 `sql/` 目录，把建表 SQL 从代码里抽出来
- [ ] `sql.sh`：按顺序执行 `sql/` 下的文件，建好 SQLite 元数据表 + ClickHouse `data` 库 + 三个账户与授权
- [ ] `docker.sh`：起 ClickHouse + 后端服务
- [ ] `Dockerfile`（Node ≥ 24，pnpm workspace 构建）
- [ ] `docker-compose.yml`
- [ ] 环境变量收敛到 `.env` + 仓库内的 `example.env` 模板
- [ ] Dockerfile 的初始化 / 启动命令先建好 `$DATA_DIR/sqlite3` 与 `$DATA_DIR/clickhouse`
      两个子目录（DESIGN 3.3.2），建不出来直接停止启动，不进 Node
      （2026-08-28 拍板：`sqliteDatabase` 保持模块级单例、**不改 Node 代码形态**，
      import 时 mkdir 与目录可写性一律由启动脚本兜底）。
      **必须用 `install -d -m 700` 而不是 `mkdir -p`**，并补一条 `test -w` 提前失败，理由有两条：
      ① `mkdir -p` 对「已存在但权限不对 / 不可写」的目录一律返回 0，挡不住任何东西；
      ② `mkdirSync(dir, { recursive: true, mode: 0o700 })` 的 `mode` **只对新建目录生效**
      （`infra/sqlite.ts:57` 与 `server.ts:11` 都是这个写法，2026-08-28 实测：已存在的 `0755`
      目录再 `mkdir(mode:0700)` 之后仍是 `755`）。而 `app.db` / `app.db-wal` / `app.db-shm`
      本身是 `644`，**唯一屏障就是那个 0700 目录**——docker 命名卷或宿主机预建目录一旦是 0755，
      DESIGN 12.3 要求的「账户表所在目录 0700」就落空，同机其他用户可读到用户名与角色明文
- [ ] **`DATA_DIR` 加绝对路径校验**（`packages/server/src/config/env.ts:22` 现在只有
      `z.string().min(1)`）。相对路径按 `process.cwd()` 解析，monorepo 下从不同目录启动
      会指向不同位置，容器里同样易踩。加一条 `.refine(isAbsolute)` 即可

动手前必须先解决的几个问题（**现在只记录，不自行拍板**）：

1. **`sql/` 能覆盖哪些表，不能覆盖哪些。**
   - 能：SQLite 的三张元数据表（`app_users` / `collect_tables` / `collect_fields`，见 DESIGN 6.2–6.4）、
     ClickHouse 的 `CREATE DATABASE data`、以及三个账户 `ch_ingest` / `ch_meta` / `ch_readonly`
     的创建与授权（DESIGN 3.4）——**这一项目前完全没有脚本，是靠手工在开发容器里敲的，最该进 `sql/`**。
   - 不能：ClickHouse 的业务数据表 `data.collect_<32位hex>`。它的物理表名是**建项目时随机生成**的，
     字段也由用户在后台定义，只能由运行期 DDL 建（`buildPhysicalTableDdl`）。`sql.sh` 建不了，也不该建。

2. **DDL 的唯一事实来源问题。** 现在 SQLite 建表语句以字符串常量写在
   `packages/server/src/bootstrap/schema.ts` 里，且 AGENTS 铁律 4 要求与 `design/06-ClickHouse数据设计.md` **逐字一致**
   （我已在阶段 B 校验过三张表逐字相同）。若把同样的 DDL 复制进 `sql/*.sql`，就出现了第三份副本，
   将来必然漂移。建议：`sql/*.sql` 作为唯一来源，`bootstrap/schema.ts` 启动时**读取**这些文件而不是内嵌字符串。
   但这会改动铁律 4 涉及的代码形态，需要先确认。

3. **`.env` 的位置与命名。** 仓库现状是 `packages/server/.env` + `packages/server/.env.example`
   （`.env.example` 已覆盖 DESIGN 附录 B 的全部变量，AGENTS 有明文要求）。
   需求里说的是根目录 `example.env`。要定：放根目录还是 `packages/server/`，
   文件名用 `example.env` 还是沿用现有的 `.env.example`，以及旧文件是删还是留。

4. **SQLite 的持久化卷。** `DATA_DIR` 下是 `sqlite3/app.db` 且开了 WAL，
   `app.db` / `app.db-wal` / `app.db-shm` 必须在**同一个卷**上，不能只挂单个文件，
   否则 WAL 会损坏。compose 里要给 `DATA_DIR` 配命名卷。

5. **`.env` 里有密钥。** `JWT_SECRET`、三个 ClickHouse 账户密码、`BOOTSTRAP_ADMIN_PASSWORD` 都在里面。
   `example.env` 只能放占位值；同时确认 `.gitignore` 真的忽略了 `.env`（现在 `packages/server/.env` 未被提交，
   但要复核规则本身而不是碰巧）。

---

## 二、验收遗留（后续阶段必须处理）

### 来自 `number` 字段类型批次（2026-08-30）验收

已验收通过的部分：`number` → `Nullable(Float64)`；上报侧显式安全范围校验（`typeof` +
`Number.isFinite` + `MAX_SAFE_INTEGER`，超范围回 `INVALID_FIELD_TYPE`）；`gt` / `gte` / `lt` / `lte`
四个范围操作符全部走 `{pN:Float64}` 参数化；SQLite 老库启动时自动迁移（读 `sqlite_schema` 比对
CHECK 原文 → 建迁移表 → 全量搬运含墓碑 → DROP → RENAME，全程在 `BEGIN IMMEDIATE` 内，幂等）；
前端数字范围与 4096 字节提示、字段名 `?` 说明（字段名仍必填）。
错误码零增删、无新增路由、`requireStatisticField` 仍只认 `'string' | 'boolean'`（未开数值聚合）。

**注意事项（2026-08-30 拍板：设计正在变，本批不修，随六类型重构一起改）**：

- **`filter.ts` 把 `lt` / `lte` 也包了 NULL，与 9.3 不符。** 9.3 明写只有
  `neq` / `not_in` / `not_contains` 三个否定类操作符生成 ``(`f` IS NULL OR <否定条件>)``。
  现在 `filter.ts:227` 的三元判断多带了 `lt` 与 `lte`，后果是「从未提交该字段」的行
  会匹配上 `score <= 100`，把 6.6 的「`NULL` = 未提交」语义弄丢。
  `query.test.ts:155,160` 与 `query.integration.test.ts:253-261`
  （变量名 `nullableLessOrEqual`，断言 `[10, null, 0]`）已把这个行为固化成预期，
  **将来修的时候这两处断言必须一起改**，否则测试会挡住正确实现。
  根因是 `AGENTS.md` 授权补充第 4 条原先把 `lte` 错列进「否定类操作符」，
  该处措辞已于 2026-08-30 订正——**因此现在 `AGENTS.md` 与代码是有意不一致的**，
  以 `AGENTS.md`（及 9.3）为准，代码待改。

**待办（等设计定稿再动）**：

- [x] **单一 `number` 要重构成六类型** —— 设计已于 2026-08-30 定稿（V4.0），
      具体待办已展开为上面的「阶段 V4」，不在本节重复。
      这里只留一条**给实现者的提醒**：`number` → `integer` / `float` 不是改个名，
      `float` 会**失去** `eq` / `in`（浮点等值不可靠，见 5.4.2），
      所以现有那些「数值等值过滤」的测试用例要按新类型重新归类，
      而不是把它们原样搬到 `float` 上。

### 来自阶段 E-4a（明细查询页）验收

**项目负责人拍板、已写进 `AGENTS.md`「对 DESIGN 的授权补充」的四条**（1 前端不再提供时区选择 /
2 CSV 导出走 File System Access API / 3 新增 `number` 字段类型 / 4 `number` 只做范围过滤不做聚合）。
攒够一批后随下一次 V3.3 回写进 `design/`，回写前以 `AGENTS.md` 为准。

**待决策（项目负责人 2026-08-29 表示还需要考虑，先记着）**：

- [ ] **10.2 数据概览的「最近上报时间」被 92 天窗口卡住。** `query` 强制时间范围且
      `maxRangeDays = 92`，因此超过 92 天没有上报的表，这张卡片只能显示「无数据」，
      而不是真实的最后上报时刻。
      可选解法：加一条窄路由（如 `GET .../last-occurred-at`，`SELECT max(_occurred_at)` 不带 WHERE，
      在 `optimize_use_implicit_projections = 1` 下几乎零成本）。
      但这与「数据概览不动服务端」的拍板冲突，**是否破例待定**。
      在决定之前，E-4b 的数据概览按 92 天窗口实现，卡片文案要说清是「最近 92 天内」。

**派工时我替 DESIGN 拍板补充的规则**（已落地，存档）：

1. **明细查询页顶部选表**，下拉过滤掉 `creating` / `failed`（服务端对这两种状态返回
   `TABLE_NOT_READY`）；选中的表同步进 URL `?projectId=`，切表清空条件、游标栈与结果。
2. **时间范围必填，默认最近 24 小时**，前端本地先校验 `start < end` 且跨度 ≤ 92 天，
   不靠服务端 400 才提示；请求体传毫秒时间戳。
3. **条件构造器的本地校验必须与服务端同构**：嵌套深度客户端 `visit(root, 1)` + `depth > 4`，
   对应服务端 `filter.ts` 的 `buildCondition(..., 1)` + `depth > maxNestingDepth`；
   条件计数 `in` / `not_in` 按数组元素各计 1，对应 `addConditionCost(state, value.length, limits)`。
   界面上要显示「已用 n/32」。
4. **游标分页由前端维护游标栈**实现上一页 / 下一页。任何进入服务端指纹的输入
   （`projectId` / `range` / `filter` / `includeFields` / `order` / `schemaVersion`）一变化，
   必须清空游标栈从第一页重查，否则服务端指纹校验直接 `INVALID_QUERY`。
   注意**指纹不含 `limit` 与 `cursor`**。
5. **列顺序与显隐按 `projectId` 存 localStorage**，纯前端状态、不给请求加任何参数；
   本地记忆里已不在返回列集合中的列丢弃，新出现的列默认显示并追加到末尾；
   **空结果时不要回写偏好**，否则会把用户的列记忆抹掉。
6. **表详情页「最近上报记录」**：最近 7 天、`limit = 20`、`order = 'desc'`、不带 filter；
   空结果显示「最近 7 天无上报记录」；`creating` / `failed` 不发请求。
7. `RATE_LIMITED` 的前端文案从「登录过于频繁」改为中性措辞——按 9.1，
   查询 / 导出的并发闸打满也返回这个码。同批还修正了 `FIELD_KEY_EXISTS` /
   `FIELD_KEY_RETIRED` 的文案（原文案与 6.4 的 `deprecated` 墓碑语义对不上），
   **错误码本身未增删改名**。

**验收记录的其他事项**：

- CSV 导出改用 File System Access API 后，**只支持 Chrome / Edge 且需安全上下文**
  （HTTPS 或 localhost）。用 http 访问内网 IP 时导出不可用，会给明确提示。
  部署到阶段 G 时要注意这一条。
- `TableDetailView` 与 `QueryView` 对 `null` / `''` / `false` 的呈现已统一到
  `packages/web/src/detail-rows.ts`（6.6 要求三者可区分）。

### 来自阶段 E-3（表详情与字段配置）验收

**派工时我替 DESIGN 拍板补充的规则**（已落地，存档）：

1. **`GET /api/admin/tables/:projectId` 的 `fields` 改为返回全部字段行**（含 `status` /
   `renamedTo` / `createdAt` / `updatedAt`），不再只返回 active。10.3 要求字段列表能看到软废弃字段，
   5.2 的墓碑 Key 也必须让操作者看得见，否则 deprecate 之后该行直接从界面消失。
   `repository.getDefinition()`（上报与查询的缓存来源）**仍然只取 active，未改动**；
   改的只是详情路由，`fields.integration.test.ts` 已补断言锁住。不新增路由、不新增错误码。
2. 详情页用 tab 分区，不新增路由；停用 / 归档加一级确认（会中断线上上报）；
   删表一级弹窗的总行数取 `row-count`，取不到时显示「行数获取失败」+重试且**不阻塞删除**；
   接入文档 endpoint 用 `window.location.origin`。

**项目负责人已拍板并落地（2026-08-29，「放开删列 + 让废弃字段可查」）**：

- [x] **`deprecated` 字段现在可以物理删除。** `repository.dropField()` 从 `requireActiveFieldSync()`
      换成新的 `requirePhysicalFieldSync()`——接受 `active` 与 `deprecated`（这两种状态下物理列都还在，
      DROP 有意义），`dropped` / `renamed` 维持 404。其余流程（`confirm` 校验、`DROP COLUMN IF EXISTS`、
      置 `dropped` 墓碑、`schema_version` 加一、清缓存）全部不变。删完 Key 变 `dropped`，
      按 5.2 就能以新类型重建成一列空列，软废弃不再是单向死胡同。
      `fields.integration.test.ts` 里原来把 PATCH / rename / deprecate / DELETE 四条一起断言 404 的用例
      **已按授权拆开**：前三条维持 404（7.3 只允许改 active 字段的元数据），DELETE 变正向用例，
      断言物理列真的消失 + 元数据变 `dropped` + 同名 Key 按新类型重建后历史行全为 NULL。
      前端「更多 → 物理删除」对 `active` 与 `deprecated` 两种字段都渲染，
      `FIELD_KEY_RETIRED` 的文案恢复成「需先物理删除该列才能复用」。
- [x] **落实 DESIGN 7.3「历史查询可以显式选择废弃字段」。** 此前 `domain/query/` 里没有任何
      deprecated 分支，7.3 这句话完全没实现。现在 `query` / `export` 的请求体新增可选
      `includeFields: string[]`（默认 `[]`，只收当前 `deprecated` 的 Key；未知 Key、`dropped` /
      `renamed` 的 Key、`_` 开头的系统列、以及本来就默认选中的 active Key，一律 `INVALID_QUERY`
      并说明原因）。最终列集合 = active + `includeFields`，合并后按 `field_key` 排序，
      保持 9.1「默认顺序即服务端返回顺序」；CSV 导出用同一套列集合。`filter` 条件与 `statistics.field`
      也放行 `deprecated`（这两处字段名本来就是显式写出来的，正是 7.3 说的「显式选择」）。
      `includeFields` 规范化后进游标指纹，翻页途中改列集合直接拒。
      `getDefinition()`（上报热路径缓存）保持只取 active 未动，查询侧要 deprecated 行时走
      `repository.listFields()`。不新增路由、不新增错误码。

- [x] **DESIGN 5.3 与 5.2 / 7.2 / 7.3 / 10.4 自相矛盾**（5.3 的表写「复用已退役字段 Key｜否｜永久禁止」、
      正文写「Key 永不复用」，而 5.2 允许 `dropped` / `renamed` 重建）。
      **已在 V3.2 修掉**：那一行拆成 `dropped` / `renamed` 与 `deprecated` 两行，
      「物理删除为什么可以直接做」与「重命名为什么可以不丢数据」两段的相关表述一并订正。

**记录备查**：

- 字段物理删除的一级弹窗在 `usage` 查询失败时会**禁用「继续」按钮**（与删表的 `row-count`
  失败不阻塞不同）。两条路径口径不同是有意的，理由已写进 DESIGN 10.4 第 2 条。
- 接入文档的「使用」示例在密钥遮罩状态下填的是 `••••`，复制按钮同时禁用，
  必须先点「显示」才能复制到明文。

### 设计回写（2026-08-29，V3.1 → V3.2）

项目负责人授权后，把积压的「设计 vs 实现」偏差一次性回写进 `design/`，详见
[`design/01-文档状态.md`](./design/01-文档状态.md) 的 V3.2 条目。涉及
01 / 05 / 07 / 08 / 09 / 10 / 12 / 15 / 17 / 附录 A / 附录 B / README，
外加 `AGENTS.md`「对 DESIGN 的授权补充」清空（五条全部进正文）。

**回写后仍未实现、留给后续阶段的两条**（设计已写、代码还没做）：

- [ ] **附录 B：`DATA_DIR` 必须是绝对路径，启动时校验并拒绝启动。** 目前只在文档里要求，
      没有启动校验。归入阶段 G，与容器化一起做。
- [ ] **10.3 的「最近上报记录」** 仍是 E-4 的范围，未受本次回写影响。

### 来自阶段 E-2（表列表与建表）验收

- [ ] **建表路径的 ClickHouse 故障映射成 `INTERNAL_ERROR`，不是 `CLICKHOUSE_UNAVAILABLE`(503)。**
      阶段 D 拍板的 `classifyClickHouseError()` 只接在查询与上报路径上，建表 / DDL 路径没接。
      2026-08-28 验收时停掉 `log-ch` 实测：表正确落 `failed`、前端列表刷新出「失败」行、
      提示是「服务暂时不可用，请稍后重试」（`INTERNAL_ERROR` 的中文映射）。
      行为正确、无数据不一致，只是错误码语义不如 503 精确。
      **2026-08-28 拍板：统一改成 503。** `domain/tables/repository.ts` 的 `create()` /
      `retry()` 里 `createPhysicalTable()` 抛出的错误，按 D 阶段同一套
      `classifyClickHouseError()` 分类：`unavailable` → `CLICKHOUSE_UNAVAILABLE`(503)，
      其余维持现状（`INTERNAL_ERROR`）。`markCreatingTableFailed(projectId)` 这一步两种情况
      都要执行，只是最终抛给路由层的错误类型要分叉。留待阶段 F 或 G 实现，不在 E 阶段动。
- [ ] **模板回填与字段列表的顺序是 `ORDER BY field_key`**（`domain/tables/repository.ts:682`），
      不是源表定义字段时的顺序。E-3 的字段配置页会看到同样的顺序。
      V1 没有「字段排序」概念（DESIGN 5.2 未定义），记录备查。

### 来自阶段 D（查询、统计与导出）验收

**派工时我替 DESIGN 拍板补充的规则**（均已落地并有测试，已拍板存档）。
其中影响外部契约的几条**已于 2026-08-29 随 V3.2 回写进设计**：故障三分类与并发闸 429 → 9.1；
`row-count` → 15.3；游标指纹 → 9.1；否定操作符包 NULL、`position` 而非 `LIKE`、
`in` / `not_in` 元素计入 `maxConditions`、过滤字段白名单 → 9.3；粒度收紧 → 附录 A。
下面保留原文作为决策记录，**设计与本节冲突时以 `design/` 为准**：

1. **ClickHouse 故障的错误码边界**（补上阶段 C 悬置的那条）。`classifyClickHouseError()` 三分类：
   - `unavailable`（`ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` / `EHOSTUNREACH` / `ENOTFOUND` /
     `socket hang up` / `AbortError` / `TimeoutError`，含 `cause` 链）
     → 查询与上报路径都抛 **`CLICKHOUSE_UNAVAILABLE`(503)**。
   - `limit_exceeded`（CH 错误码 159 `TIMEOUT_EXCEEDED` / 160 `TOO_SLOW` /
     241 `MEMORY_LIMIT_EXCEEDED` / 396 `TOO_MANY_ROWS_OR_BYTES`）
     → 查询路径抛 **`INVALID_QUERY`(400)**，提示缩小时间范围或减少条件。
     这是用户的查询太重，不是服务故障，回 5xx 会误导前端重试。
   - `server_error`（其余一切）→ 查询路径 **`INTERNAL_ERROR`(500)** 并 `log.error` 原始错误；
     上报路径保持 **`INSERT_FAILED`(500)**。
2. **`GET /api/admin/tables/:projectId/row-count` 是 DESIGN 15.6 之外新增的第 4 条路由。**
   DESIGN 10.4 要求删表一级确认弹窗实时展示「该表当前的总行数」，而 `query` / `statistics`
   都强制带时间范围（DESIGN 9.1），拿不到全表总数。它与已有的
   `GET .../fields/:fieldKey/usage`（同样是 10.4 确认弹窗专用、同样不在 15.x 路由列表里）
   完全对称，权限因此也对齐 `admin` 起。实现是 `SELECT count() FROM data.<physical>`，
   无 `WHERE`、无 `FINAL`，走 `readonlyClient`。
   注意它统计的是**未 merge 的物理行数**，同一 `recordId` 重试过的会略高估——
   用途是「让操作者看到大致会丢多少数据」，这个精度足够（DESIGN 2.1 / 8.5）。
3. **并发闸满立即拒绝，不排队**：`RATE_LIMITED`(429)。`query` 与 `statistics` 与 `row-count`
   共用 `query.maxConcurrent`(8)，`export` 独占 `export.maxConcurrent`(2)。
   没有更贴切的错误码且不许新增，`RATE_LIMITED` 是唯一合理映射。
4. **游标绑定查询指纹**：游标载荷是 `{ at, id, fp }`，`fp` 是
   `sha256(canonicalJson({projectId, range, filter, order, schemaVersion}))` 的前 16 位 hex。
   换了筛选条件却复用旧游标会导致漏行/重行，因此指纹不匹配一律 `INVALID_QUERY` 而不是静默出错。
   `schemaVersion` 进指纹意味着**翻页途中表结构变更会强制重新分页**，这是有意的（列集合变了）。
5. **时区必须由客户端传，服务端没有任何默认值**（DESIGN 9.2）。已核实全仓没有
   `Intl.resolvedOptions()` 兜底、没有读 `process.env.TZ`、没有 `tz ?? '...'` 之类的默认值：
   `statistics` 缺 tz / 空串 / null 一律 400。
   **只有 `trend` 的 `minute` 粒度不带 tz**，这是 DESIGN 9.2 的原文规定，也确实无需：
   分钟桶的边界在所有 IANA 时区都对齐（连 `Asia/Kathmandu` 的 +05:45 也是整分钟偏移）。
   **明细 `query` 与 `export` 不收 tz**，它们返回 UTC ISO-8601 瞬间，由前端按全局时区格式化——
   DESIGN 9.2 只要求「按时间粒度聚合的接口」带时区。
   `trend` 的桶值同样以 UTC ISO 串返回（由 `toUnixTimestamp(bucket)` 转出），
   语义无歧义，前端用同一个 tz 格式化即可显示成本地日期。

6. **趋势查询按粒度收紧时间跨度**：`minute` 粒度 ≤ 2 天、`hour` 粒度 ≤ 31 天，超出 `INVALID_QUERY`。
   附录 A 只给了统一的 `maxRangeDays = 92`，但 92 天 × 分钟粒度是 13 万个桶，
   会把响应体和前端图表一起打爆。`day` 粒度不额外收紧（92 桶）。
7. **否定类操作符必须显式包住 NULL**：`neq` / `not_in` / `not_contains` 一律生成
   `(\`f\` IS NULL OR <否定条件>)`。否则 ClickHouse 的三值逻辑会把 NULL 行整个吞掉，
   用户选「不等于 A」却看不到未提交该字段的行。已有集成测试锁住。
8. **子串匹配用 `position(col, {v:String}) > 0` 而不是 `LIKE`**，
   免掉转义用户输入里 `%` 和 `_` 的出错面。大小写敏感。
9. ~~**过滤字段白名单只认当前 active 字段**，已废弃 / 已删除 / 已改名的字段等同未知字段 →
   `INVALID_QUERY`。~~ **已于 2026-08-29 按「让废弃字段可查」的拍板作废**：`filter` 与
   `statistics.field` 现在放行 `deprecated` 字段（见上文 E-3 验收那条）。仍然成立的部分是——
   `_` 开头的系统列一律拒绝（时间范围已单独处理），`dropped` / `renamed` / 未知字段仍等同未知字段
   → `INVALID_QUERY`。
10. **`in` / `not_in` 的数组元素数计入 `maxConditions`**（32），避免用一个条件塞进上万个值。

- [x] **CSV 导出走 `reply.hijack()`，因此 `app.ts` 的 `onResponse` 四要素日志（DESIGN 12.4 的
      `route` / `statusCode` / `durationMs`）对 export 请求不会输出。**
      已由 `logHijackedResponse()` 在三个退出路径（正常结束 / 流中途失败 / hijack 后异常）各补一条
      `request completed`，字段与全局钩子同构，另加 `bodyComplete` 区分完整下载与中断。
      计时起点统一收在 `request-timing.ts`，与 `onRequest` 钩子同源，口径和其他请求一致。
- [x] **CSV 里的 `_occurred_at` / `_received_at` 是 ClickHouse 原始格式**
      （`2026-08-27 08:11:03.219`），而明细 JSON 走 `clickHouseDateTimeToIso()` 转成了 ISO-8601。
      两者不一致。CSV 是给 Excel / 人看的，原始格式反而更友好，暂不统一，但阶段 E 做导出按钮时要知道。
- [x] **上报路径新增的 `CLICKHOUSE_UNAVAILABLE` 分支没有端到端测试。**
      `classifyClickHouseError()` 本身在 `query.test.ts` 有单测（连接错误 / abort / 嵌套 cause /
      限额 / 服务端错误五类都覆盖了），`ingest/routes.ts` 里的接线只有 3 行，
      风险很低，但严格说没测到。留给阶段 F。
- [x] **导出的截断行数在极端情况下会略偏**：`total` 来自导出前的一次 `count()`，
      如果两次查询之间又写入了新行，末行注释里的 `of <total>` 会略小于真实值。可忽略。
- [x] **查询组四个接口（query / statistics / export / row_count）的日志缺 `operator`。**
      DESIGN 12.3 说「不做审计日志表，需要追溯谁改的时看结构化日志」，前提是日志里有「谁」。
      `logSuccess` / `logFailure` 已补 `operator`；鉴权失败时 `request.user` 尚未填充，
      由 `operatorForLog()` 安全缺省为 `undefined`，已有测试锁住这两种情况。
- [x] **`GET /api/admin/tables/:projectId/secret` 是明文上报密钥的唯一读取出口，此前没有业务日志。**
      已补 `read_table_secret`（`operator` / `projectId` / `schemaVersion`）。
      测试同时断言密钥明文不出现在任何日志记录里。

---

## 三、注意事项

- **`create()` 把字段元数据写在建物理表之前，与 7.1 的字面步骤顺序不同，这是有意的，不要「改正」。**
  这样 `retry()` 才能从已持久化的字段定义重建物理表，是幂等重试成立的前提。
  副作用：`failed` 的表可能出现「字段元数据有、物理表没有」的中间态，
  ~~阶段 B 的 reconcile 必须覆盖这种情况~~ → **B-1 已覆盖**：这类表在 reconcile 里保持 `failed`
  （`reconcileTableStatuses` 对「`failed` 且物理表不存在」直接 `continue`），等管理员点 retry
  从已持久化的字段定义重建；B-2 又补了「这类表可以不经归档直接删除」的路径。
- 不得实现第 16 节「非目标」中的任何内容（SQLite 自 V3 起**不在**非目标里）。
- 每阶段结束需保证 `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test` 全绿。
- 物理表名 / 列名只能来自服务端白名单，所有值必须参数化；SQLite 侧一律预编译语句绑定。
- 业务数据表查询一律不加 `FINAL`；元数据已在 SQLite，`FINAL` / `PREWHERE` 注意事项不再适用。
- 唯一性靠数据库约束，不靠先查后写。
- **nonce 攻击原理（已知且判定 V1 可接受，不要当缺陷重开）**：`routes.ts` 里的校验顺序是
  时间窗 → `nonceCache.consume()` → 验签（照抄 DESIGN 8.1.2 原文顺序），`consume()`
  无条件执行、不等验签结果。因此攻击者**不需要拿到 `ingestSecret`**，只要拿任意伪造的
  `(projectId, nonce)` 对猛发请求，就能把 10 万容量的进程内 LRU（`nonce.ts`）刷满，
  将合法请求已记录的 nonce 挤出缓存——被挤出等于"看起来没出现过"，原本已用过的 nonce
  因此可以被重新提交、绕开 `REPLAYED_NONCE`。唯一挡这条路的是前置的 IP 令牌桶限流
  （100/秒）。签名本身不受影响（改 nonce 会导致签名对不上，见 `design/08-上传接口.md:44`），
  这条攻击面只用来刷 nonce 缓存本身，不能用来伪造合法数据。
