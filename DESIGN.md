# 前端主动上报数据采集系统设计

## 1. 文档状态

- 状态：V2 设计稿（V1 评审后修订）
- 目标：用于指导前后端、ClickHouse 表结构和管理后台的实现
- 系统定位：面向前端主动调用接口的动态数据采集与统计系统

## 2. 产品定义

本系统不是自动采集用户行为的传统前端埋点 SDK，也不是提交后可反复编辑的业务表单系统。

系统采用“数据采集表”模型：

1. 管理员在后台创建一个产品项目对应的数据采集表。
2. 管理员为数据采集表配置字段并发布。
3. 系统生成公开 `tableId`、`projectId` 和上报签名密钥。
4. 业务前端按签名协议主动调用上传接口，传入一份完整数据。
5. 一次上传在对应 ClickHouse 物理表中写入一行。
6. 管理后台按照时间和业务字段进行筛选、分组与统计。

V1 的核心约束：

- 不提供官方 npm SDK，但提供可直接复制的 TypeScript 上报示例代码。
- 不自动采集页面行为，只记录主动调用上传接口的数据。
- 一个产品项目对应一张长期存在的 ClickHouse 物理数据表。
- 一次上报对应一行，不拆分成事件表和属性表。
- 业务字段直接展开为 ClickHouse 列，不使用 `data JSON` 存储上报数据。
- 数据以追加为主，已写入的采集记录不支持编辑。
- 系统只维护记录标识与时间，**所有业务语义（含用户标识、会话标识）都由建表时的自定义字段承担**。
- V1 业务字段只支持字符串和布尔值。
- 枚举、单选、状态等统一按字符串存储，不使用 ClickHouse `Enum`。

### 2.1 数据保证等级（重要）

本系统是**埋点日志系统**，不是账务系统。明确接受以下不精确性，不要在此之上构建对账类业务：

| 维度 | 保证 |
|---|---|
| 不丢 | **不保证**。网络失败、进程重启、CH 不可用都可能丢行，调用方可自行重试，也可放弃。 |
| 不重 | **不保证严格唯一**。`ReplacingMergeTree` 按 `_record_id` 尽力收敛，但收敛发生在后台 merge 之后，查询不加 `FINAL`，短期内可见重复。 |
| 计数精度 | **近似**。统计结果只反映“已入库的数据”，少量出入属预期行为。 |
| 调用方义务 | 同一条逻辑记录重试时必须复用同一个 `recordId`；**前端自身应做本地去重**，避免同一事件重复发送。 |

## 3. 技术栈

### 3.1 前端

- Vite 最新稳定版
- Vue 3
- TypeScript
- `<script setup>`
- Vue Router
- Pinia
- Element Plus
- ECharts

### 3.2 后端

- Node.js 当前 LTS
- TypeScript
- Fastify
- AJV 或 Zod
- OpenAPI
- ClickHouse 官方 Node.js Client

### 3.3 存储

V1 只使用 ClickHouse，不引入 SQLite、MySQL、PostgreSQL、Redis 和消息队列。

ClickHouse 同时保存：

- 后台账户
- 数据采集表元数据
- 字段定义和版本
- 实际采集数据

要求 ClickHouse 部署**当前最新稳定版**（最低 24.8 LTS，需要 `Bool` 类型与轻量 `DELETE`）。

账户和元数据属于低频、小数据量操作。ClickHouse 不是事务型数据库，V1 接受以下约束：

- 只部署一个 Node 后端实例。
- 唯一性由 Node 查询并校验，数据库不提供强唯一约束。
- 元数据采用追加版本记录，读取当前状态时使用 `FINAL`。
- 跨表 DDL 和元数据写入不具备事务原子性，通过状态机与启动期 reconcile 恢复。

#### 3.3.1 并发模型：上报不加锁，元数据写入串行

Node 是**单线程并发**，不是串行：两个并发请求会各自 `await` 一次查询，可能读到同一个 `version` 并写回同一个 `version + 1`，`ReplacingMergeTree` 去重时会静默丢弃其中一条。因此：

- **上报路径不加任何锁。** 纯 append，没有读-改-写，加锁只会成为瓶颈。
- **所有元数据写入串行执行。** 建表、加字段、删字段、改状态、账户增删改，全部经过同一条 Promise 链。这些是人工触发的低频操作，串行化的性能代价为零；不串行的后果是静默丢失一次字段变更，并留下“ClickHouse 列已加但元数据没记”的不一致状态，排查成本极高。

```ts
// src/infra/serial.ts —— 全部元数据写入的唯一入口
let chain: Promise<unknown> = Promise.resolve();

export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}
```

如果未来需要多后端实例、强事务、严格唯一约束或高频管理操作，再引入 PostgreSQL。

### 3.4 ClickHouse 账户划分

必须使用三个独立账户，权限互不重叠：

| 账户 | 权限 | 用途 | `async_insert` |
|---|---|---|---|
| `ch_ingest` | `data.*` 的 `INSERT` | 上报写入 | 在**查询级**显式开启 |
| `ch_meta` | `meta.*` 全部；`data.*` 的 `CREATE/ALTER/DROP` | 建表、DDL、元数据读写 | **必须关闭** |
| `ch_readonly` | `data.*` 与 `meta.*` 的 `SELECT` | 后台查询、统计、导出 | 不适用 |

`async_insert` 一旦配在 user profile 上就会污染元数据写入：`INSERT INTO meta.collect_tables` 进入异步队列后，紧随其后的 `SELECT ... FINAL` 读不到刚写的版本，建表状态机和缓存失效会随机失败。**因此 `async_insert` 只能作为上报路径的 query-level setting 传入，绝不能配在账户或全局配置上。**

## 4. 总体架构

```text
业务前端
  │
  │ signed envelope（tableId + projectId + HMAC 签名 + 一行数据）
  ▼
Node.js API
  ├── 签名校验（时间窗 + nonce）
  ├── 表 ID 解析
  ├── 内存元数据缓存
  ├── 字段白名单与类型校验
  ├── 上传限流
  └── 参数化 INSERT（完整列集合）
  │
  ▼
ClickHouse
  ├── meta.app_users
  ├── meta.collect_tables
  ├── meta.collect_fields
  └── data.collect_<internal_id>

Vue 管理后台
  │
  ▼
Node.js 管理与查询 API
  ├── 账户管理
  ├── 数据表与字段管理
  ├── 数据查询构造器
  └── 统计查询
```

管理后台和业务前端均不能直接连接 ClickHouse。

## 5. 核心领域模型

### 5.1 数据采集表

数据采集表是系统的数据隔离单元，V1 中一张表对应一个产品项目。

主要属性：

- 公开 `tableId`：路由标识，用于定位物理表
- 公开 `projectId`：签名主体标识，用于查找上报密钥
- `ingestSecret`：HMAC 上报密钥（详见 8.1）
- 内部 ClickHouse 物理表名
- 显示名称、描述
- 状态
- 当前 Schema 版本
- 创建人用户名快照和创建时间

字段不是本实体的内嵌属性，而是独立实体，一个字段一行存放于 `meta.collect_fields`（见 6.4）。

状态与允许的迁移：

| 当前状态 | 含义 | 允许迁移到 |
|---|---|---|
| `creating` | 正在创建物理表 | `active`、`failed` |
| `active` | 允许上传和查询 | `disabled`、`archived` |
| `disabled` | 停止上传，仍允许查询 | `active`、`archived` |
| `archived` | 归档，只允许历史查询 | `active` |
| `failed` | 创建或变更失败 | `creating`（重试）、`archived` |

任何不在上表中的迁移请求返回 `TABLE_STATE_CONFLICT`。V1 不提供物理删除数据采集表的功能，避免误删历史数据。

### 5.2 字段

V1 字段定义只包含必要信息：

```json
{
  "key": "login_method",
  "label": "登录方式",
  "type": "string",
  "required": true,
  "deprecated": false,
  "description": "本次登录使用的方式"
}
```

字段属性：

- `key`：对应 ClickHouse 物理列名，发布后不可修改
- `label`：管理后台展示名称，可以修改
- `type`：`string` 或 `boolean`，发布后不可修改
- `required`：当前 Schema 版本上传时是否必填
- `deprecated`：是否已软废弃（列和历史数据仍在）
- `description`：字段说明

字段 Key 规则：

- 必须匹配 `^[a-z][a-z0-9_]{0,63}$`（该正则已经排除了 `_` 前缀，系统字段因此天然不会被占用）
- 只要求在同一数据采集表内唯一
- 一旦退役，**永久不可复用**：软废弃、物理删除、重命名后的旧 Key 都会在 `meta.collect_fields` 中留下一行非 `active` 记录，该记录本身就是 tombstone —— 只要 `(table_id, field_key)` 存在任何一行，就不允许再次创建
- 唯一例外是「修改字段类型」：该操作物理清除原列后以同名重建，只是更新同一行的 `type`，Key 从未退役，因此不受影响（见 5.3）

### 5.3 Schema 版本

每次新增字段、修改必填规则、废弃字段或删除字段时，`schema_version` 加一。

每行采集数据写入当时的版本号，便于解释历史数据。

字段变更规则：

| 操作 | 是否允许 | 数据影响 | 处理方式 |
|---|---:|---|---|
| 修改字段显示名称 | 是 | 无 | 只修改元数据，版本不变 |
| 修改字段描述 | 是 | 无 | 只修改元数据，版本不变 |
| 修改是否必填 | 是 | 无 | 只修改校验规则，版本加一 |
| 新增字段 | 是 | 无 | `ADD COLUMN`，版本加一 |
| **重命名字段 Key** | 是 | **数据完整保留** | `RENAME COLUMN`，旧 Key 行置 `renamed`，新增一行 `active`，版本加一 |
| **修改字段类型** | **是（高危）** | **该列历史数据永久丢失** | `DROP COLUMN` + `ADD COLUMN`，需二次确认，版本加一 |
| 软废弃字段 | 是 | 无 | 该行置 `deprecated`，列与数据保留 |
| **物理删除字段** | **是（高危）** | **该列历史数据永久丢失** | `DROP COLUMN`，该行置 `dropped`，需二次确认，版本加一 |
| 复用已退役字段 Key | 否 | — | 永久禁止 |

三条说明：

**物理删除为什么可以直接做。** ClickHouse 是列式存储，`DROP COLUMN` 只需删除每个 part 中该列的 `.bin` / `.mrk` 文件，**不重写其他列**，属于轻量 mutation，基本瞬时完成。所以代价不是问题，需要守住的只有语义约束——删除后历史数据不可恢复，且 Key 永不复用，否则同一列名在不同时间段含义不同，历史查询必然出错。

**重命名为什么可以不丢数据。** `ALTER TABLE ... RENAME COLUMN a TO b` 是纯元数据操作，数据文件原地保留。因此改名后用新 Key 就能查到该字段的**全部历史数据**，这是比“新增 + 废弃”优越得多的做法。代价只有一个：前端上报代码必须同步改用新 Key，否则旧 Key 会被当成未知字段拒绝。旧 Key 的记录行保留为 `renamed` 状态并指向新 Key，既阻止复用，也保留了变更链可追溯。

**修改类型为什么必须丢数据。** 理论上 `MODIFY COLUMN` 能做部分转换，但两个方向都不可用：`string → boolean` 会因为任意字符串无法转 Bool 而让 mutation 直接失败；`boolean → string` 虽然能跑，但 `Bool` 底层是 `UInt8`，转换结果是 `'0'` / `'1'` 而不是 `'false'` / `'true'`，会静默产出一批语义错误的历史数据。与其提供一个在一半场景下失败、另一半场景下悄悄弄脏数据的功能，不如统一实现为 **`DROP COLUMN` + `ADD COLUMN`（同名，新类型）**：语义单一、结果可预测，代价是该列历史数据清零。由于是物理删除后重建，不存在“同名列在不同时间段含义不同”的问题，因此 Key 允许保持不变。

## 6. ClickHouse 数据设计

### 6.1 数据库

```sql
CREATE DATABASE IF NOT EXISTS meta;
CREATE DATABASE IF NOT EXISTS data;
```

`meta` 保存管理数据，`data` 保存业务上报数据。

### 6.2 账户元数据表

```sql
CREATE TABLE IF NOT EXISTS meta.app_users
(
    user_id       UUID,
    username      String,
    password_hash String,
    role          String,
    status        String,
    version       UInt64,
    created_at    DateTime64(3, 'UTC'),
    updated_at    DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(version)
ORDER BY username;
```

约束由 Node 实现（全部在 `serial()` 串行队列内执行）：

- `username` 全局唯一，是本表的去重键。
- 密码只保存 Argon2id 哈希。
- `role` 只允许 `super_admin`、`admin`、`user`。
- 账户删除是**物理删除**（`DELETE FROM meta.app_users WHERE username = ...`），不做软删除。需要时重新创建同名账户即可。
- 因为账户会被物理删除，`meta.collect_tables.created_by` 只保存用户名字符串快照，仅用于展示，不构成外键。

读取当前账户：

```sql
SELECT *
FROM meta.app_users FINAL
WHERE username = {username:String}
  AND status = 'active';
```

账户更新通过插入更高 `version` 的新记录实现；`version` 的读取与写回必须在同一个 `serial()` 临界区内完成。

关于 `FINAL` 的正确性：必须显式固定 `optimize_move_to_prewhere_if_final = 0`（这也是默认值），并且**禁止应用层把 `status` 等版本相关列写进 `PREWHERE`**。否则过滤会发生在版本合并之前，已被禁用的账户可能“复活”。

### 6.3 数据采集表元数据

```sql
CREATE TABLE IF NOT EXISTS meta.collect_tables
(
    table_id           String,
    project_id         String,
    physical_name      String,
    display_name       String,
    description        String,
    status             String,
    schema_version     UInt32,
    ingest_secret      String,
    ingest_secret_prev String,
    created_by         String,
    version            UInt64,
    created_at         DateTime64(3, 'UTC'),
    updated_at         DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(version)
ORDER BY table_id;
```

说明：

- `table_id` 是前端使用的公开路由 ID，例如 `tbl_01KABCDEF...`。
- `project_id` 是签名主体 ID，例如 `prj_01KABCDEF...`。V1 中与 `table_id` 一一对应，独立存在是为了将来一个项目挂多张表时不必改上报协议。
- `physical_name` 由服务端生成，例如 `collect_a8f31c...`，永远不使用用户输入。
- `ingest_secret` / `ingest_secret_prev` 支持密钥轮换期间双密钥并存。
- 本表**只保存表级属性，不保存字段定义**。字段是独立实体，见 6.4。
- 查询当前配置必须使用 `FINAL`。

公开 ID 不是密钥，不能作为安全认证凭据。

### 6.4 字段元数据表

```sql
CREATE TABLE IF NOT EXISTS meta.collect_fields
(
    table_id       String,
    field_key      String,
    label          String,
    type           String,
    required       Bool,
    description    String,
    status         String,
    renamed_to     String,
    schema_version UInt32,
    version        UInt64,
    created_at     DateTime64(3, 'UTC'),
    updated_at     DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (table_id, field_key);
```

**一个字段一行。** 这与 2. 产品定义中“业务字段展开为物理列、不用 JSON 兜底”的原则一致——把 N 个字段挤进一个 `fields_json` 字符串列会导致：改一个 label 要读写整个字段数组、每个版本行复制一份全量定义、以及 ClickHouse 完全无法参与字段维度的查询。字段是独立实体，就该独立成行。

字段说明：

- `(table_id, field_key)` 是去重键，因此同一张表内 Key 天然唯一。
- `status` 取值：

| status | 含义 | 物理列 | 历史数据 | 可上报 |
|---|---|---|---|---|
| `active` | 正常 | 在 | 在 | 是 |
| `deprecated` | 软废弃 | 在 | 在 | 否 |
| `dropped` | 物理删除 | 已删 | 已丢失 | 否 |
| `renamed` | 已重命名 | 已改名 | 在（新 Key 下） | 否 |

- `renamed_to`：仅 `status = 'renamed'` 时有值，指向新 Key，用于追溯历史变更链。
- `schema_version`：本次变更完成后表的 Schema 版本，用于解释“这个字段是从哪个版本开始存在/停止存在的”。
- **退役即 tombstone**：`(table_id, field_key)` 只要存在任何一行，该 Key 就不能再被创建，无需单独维护退役列表。

关键查询：

```sql
-- 当前有效字段（上报校验与查询白名单的唯一来源）
SELECT field_key, label, type, required, description
FROM meta.collect_fields FINAL
WHERE table_id = {tableId:String}
  AND status = 'active'
ORDER BY field_key;

-- Key 是否可用（返回 0 才允许创建）
SELECT count()
FROM meta.collect_fields FINAL
WHERE table_id = {tableId:String}
  AND field_key = {fieldKey:String};

-- 历史查询：允许显式选择已软废弃的字段
SELECT field_key, label, type
FROM meta.collect_fields FINAL
WHERE table_id = {tableId:String}
  AND status IN ('active', 'deprecated');
```

拆表后新增的能力（`fields_json` 时代做不到）：跨表检索字段，例如「哪些采集表定义了 `user_id`」「全系统还有哪些字段没被废弃」，直接一条 SQL 即可，不必把所有表的定义拉到 Node 里解析。

字段变更只插入受影响的那一行，不触碰同表其他字段，写放大与并发冲突面都降到最小。

### 6.5 业务数据表

创建数据采集表时，Node 根据字段定义生成物理 DDL。

示例：

```sql
CREATE TABLE data.collect_a8f31c
(
    `_record_id`      UUID,
    `_schema_version` UInt32,
    `_occurred_at`    DateTime64(3, 'UTC'),
    `_received_at`    DateTime64(3, 'UTC') DEFAULT now64(3),

    `user_id`         Nullable(String),
    `login_method`    Nullable(String),
    `result`          Nullable(String),
    `is_new_device`   Nullable(Bool)
)
ENGINE = ReplacingMergeTree(_received_at)
PARTITION BY toYYYYMM(_occurred_at)
ORDER BY
(
    toDate(_occurred_at),
    _occurred_at,
    _record_id
);
```

系统字段只有四个，统一以 `_` 开头，业务字段禁止使用该前缀（5.2 的 Key 正则已保证）。上例中的 `user_id` 是**业务自定义字段**，不是系统字段——是否记录用户标识、叫什么名字、是否必填，全部由建表人决定。

设计要点：

- **`ReplacingMergeTree(_received_at)`**：同一 `_record_id` 的重试会在后台 merge 时收敛，保留 `_received_at` 最大的一条。查询**不加 `FINAL`**（宽表加 `FINAL` 代价过高），所以 merge 完成前可见重复，这与 2.1 的保证等级一致。
- **去重键与分区键都基于 `_occurred_at`**：`_occurred_at` 是前端传入的固定值，重试时完全相同，因此重试行必然落在同一分区、同一排序键上，去重才能生效。若分区键改用 `_received_at`，跨天或跨月重试就会落到不同分区而永远无法收敛。
- **分区键安全性的前提是时间窗校验**：`_occurred_at` 由客户端提供，如果不校验，伪造一个 2099 年的时间戳就能凭空创建一个分区，几十个伪造月份即可让表因 `Too many parts` 停止写入。因此 8.2 的 `occurredAt` 范围校验是**强制**的，不是可选项，它把分区跨度限制在两个相邻月份内。

### 6.6 自定义字段物理类型

| 业务类型 | ClickHouse 类型 |
|---|---|
| string | `Nullable(String)` |
| boolean | `Nullable(Bool)` |

所有业务字段物理上一律允许 `NULL`，包括标记为 `required` 的字段。原因是 `ADD COLUMN` 之后历史行必然没有对应值，如果新增的必填字段是非 Nullable 的，历史行会被读成类型默认值而无法与“真实提交了默认值”区分。是否必填由 Node 按当前 Schema 版本校验。

空值语义：

- `NULL`：本行没有提交该字段
- 空字符串：明确提交了空字符串
- `false`：明确提交了布尔假值

V1 不支持：

- 数值字段
- 自定义时间字段
- 数组
- 嵌套对象
- 文件
- ClickHouse Enum

因此 V1 支持字符串/布尔值的等值筛选、包含筛选、分组和计数，但不支持业务字段的求和、平均值和数值范围查询。若未来出现耗时、金额、分数等统计需求，应新增 `number` 类型并映射为 `Nullable(Float64)`，不能把已有字符串字段直接改成数值字段。

## 7. 数据表创建与字段变更

所有本节操作都在 `serial()` 串行队列内执行，使用 `ch_meta` 账户。

### 7.1 创建数据表

1. Node 生成 `tableId`、`projectId`、`physical_name` 和 `ingestSecret`（32 字节随机，Base64URL）。
2. 向 `meta.collect_tables` 插入 `creating` 版本。
3. 使用服务端生成且经过校验的字段名创建 ClickHouse 物理表。
4. 成功后插入新的 `active` 元数据版本。
5. 返回 `tableId`、`projectId`、`ingestSecret` 和上报示例代码。
6. 失败时写入 `failed` 状态，允许管理员幂等重试。

Node 不能使用用户输入的项目名称作为物理表名。

### 7.2 新增字段

```sql
ALTER TABLE data.collect_a8f31c
ADD COLUMN IF NOT EXISTS `country` Nullable(String);
```

执行顺序：

1. 校验字段 Key 在 `meta.collect_fields` 中不存在任何记录行（含各种退役状态）。
2. 执行 `ADD COLUMN IF NOT EXISTS`。
3. 向 `meta.collect_fields` 插入一行 `status = 'active'`，并递增 `collect_tables.schema_version`。
4. 清除 Node 进程内对应表结构缓存。

该操作设计为幂等，DDL 成功但元数据更新失败时可以安全重试。

### 7.3 修改、废弃与删除字段

**修改 label / description / required**（无数据影响）：

向 `meta.collect_fields` 插入该字段的新版本行，不触碰物理表。前两者 `schema_version` 不变，`required` 变更加一。

**重命名字段 Key**（无数据影响）：

```sql
ALTER TABLE data.collect_a8f31c RENAME COLUMN `country` TO `country_code`;
```

1. 校验新 Key 符合 5.2 规则，且在 `meta.collect_fields` 中不存在任何记录行。
2. 执行 `RENAME COLUMN`。
3. 写两行：旧 Key 行更新为 `status = 'renamed'`、`renamed_to = <新 Key>`；新 Key 插入一行 `status = 'active'`，继承原有的 label / type / required / description。版本加一。
4. 清除缓存。
5. 响应中返回提示：前端上报代码需同步改用新 Key，否则旧 Key 的上报会被拒绝。

**修改字段类型**（高危，该列历史数据永久丢失）：

```sql
ALTER TABLE data.collect_a8f31c DROP COLUMN IF EXISTS `is_new_device`;
ALTER TABLE data.collect_a8f31c ADD  COLUMN IF NOT EXISTS `is_new_device` Nullable(String);
```

1. 请求体必须携带 `confirm`，其值等于 `fieldKey`，否则返回 `CONFIRMATION_REQUIRED`。
2. 按顺序执行 `DROP COLUMN` 与 `ADD COLUMN`（同名，新类型）。
3. 向 `meta.collect_fields` 插入该字段的新版本行，只改 `type`，`status` 保持 `active`。Key 从未退役，因此不影响后续使用。版本加一。
4. 清除缓存。

该操作**不是幂等的中途可恢复操作**：若在 `DROP` 成功、`ADD` 失败之间崩溃，字段会暂时消失。7.4 的 reconcile 会检测到“元数据有、物理列没有”并自动补建，因此最终仍会收敛，但补建出的列是空的——这与操作本意一致（类型变更本来就清空数据）。

**软废弃**（默认，保留数据）：

- `meta.collect_fields` 中该行更新为 `status = 'deprecated'`。
- 上传接口拒绝继续提交该字段。
- 新建查询默认隐藏该字段，历史查询可以显式选择。
- ClickHouse 物理列和历史数据保留。

**物理删除**（高危，数据不可恢复）：

```sql
ALTER TABLE data.collect_a8f31c DROP COLUMN IF EXISTS `country`;
```

1. 请求体必须携带 `confirm` 字段，其值等于待删除的 `fieldKey`，否则返回 `CONFIRMATION_REQUIRED`。
2. 执行 `DROP COLUMN IF EXISTS`。
3. `meta.collect_fields` 中该行更新为 `status = 'dropped'`（记录行保留，作为 tombstone），递增 Schema 版本。
4. 清除缓存。

该行永久保留为 `dropped`，Key 不允许以任何理由重新创建。

如因敏感信息或法律要求必须清理行级数据，见 14.2 的运维流程。

### 7.4 启动期状态收敛（reconcile）

多步 DDL 流程没有事务性，进程在“物理表已建但 `active` 元数据未写入”之间崩溃，表会永远卡在 `creating` 且无人察觉。因此后端**每次启动时必须执行一次 reconcile**：

1. 读取 `meta.collect_tables FINAL` 中所有 `creating` 和 `failed` 的表。
2. 对照 `system.tables` 判断物理表是否存在：存在则补写 `active` 元数据；不存在则置为 `failed`。
3. 对所有 `active` 的表，对照 `system.columns` 与 `meta.collect_fields` 中 `status = 'active'` 的行做 schema drift 校验：
   - 元数据有、物理列没有 → 补 `ADD COLUMN`；
   - 物理列有、元数据完全没有记录行 → 记录告警日志，不自动处理；
   - 物理列有、元数据标记为 `dropped` → 说明上次删除只完成了元数据侧，补执行 `DROP COLUMN`。
4. reconcile 全程写结构化日志，失败不阻塞进程启动，但必须在 `/healthz` 中暴露最近一次 reconcile 的结果。

## 8. 上传接口

### 8.1 上报防护：HMAC-SHA256 签名

**安全边界声明（必读）**：密钥保存在前端就是公开的，混淆只能提高逆向门槛，无法真正保密。这套机制的定位是 **anti-casual-abuse（阻止随手刷接口）**，**不是身份认证**。因此：

- 上报接口的全部输入都是**不可信数据**。
- 上报数据中的任何字段（包括自定义的 `user_id` 之类）**不构成身份证明，禁止用于任何权限判断**。
- 密钥泄露的后果是数据被污染，不涉及越权读取——上报账户只有 `data.*` 的 INSERT 权限。

#### 8.1.1 Envelope 格式

签名信息**放在 body 内而不是 HTTP 头**。这是刻意的：任何 `X-` 自定义请求头都会触发 CORS 预检，而预检在页面卸载期间基本发不出去，`sendBeacon` 会直接失效。把签名放进 body 并使用 `text/plain;charset=UTF-8`，请求就是 CORS 简单请求，无预检，`sendBeacon` 和 `fetch keepalive` 都能正常工作。

```http
POST /api/ingest/v1/tables/:tableId/rows
Content-Type: text/plain;charset=UTF-8
```

```json
{
  "p": "prj_01KABCDEF...",
  "t": 1756012830123,
  "n": "a3f9c2d1b7e40851",
  "s": "9b1f4c...64位hex...",
  "d": "{\"recordId\":\"bea94960-7fbe-4853-a689-8a309c471627\",\"occurredAt\":1756012830123,\"data\":{\"login_method\":\"sms\",\"result\":\"success\",\"is_new_device\":true}}"
}
```

| 字段 | 含义 |
|---|---|
| `p` | `projectId` |
| `t` | 客户端毫秒时间戳，用于时间窗校验 |
| `n` | 随机 nonce，16 位 hex |
| `s` | 签名，hex 小写 |
| `d` | **原始明文 JSON 字符串**，即真正的上报载荷 |

`d` 保持字符串而非嵌套对象，是为了让签名针对确切的字节序列，服务端直接对收到的 `d` 验签后再 `JSON.parse`，彻底避免 JSON key 顺序导致的签名不一致。

#### 8.1.2 签名算法

```text
signBase  = p + "\n" + t + "\n" + n + "\n" + d
signature = hex(HMAC_SHA256(ingestSecret, signBase))
```

服务端校验顺序：

1. `p` 能查到对应的采集表，且 URL 中的 `tableId` 与之匹配。
2. `|now - t| <= 5min`，否则 `SIGNATURE_EXPIRED`。
3. `n` 在进程内 LRU（容量 10 万，TTL 5 分钟）中未出现过，否则 `REPLAYED_NONCE`。重启后该窗口清空，最多允许 5 分钟内的重放——由于重放行的 `recordId` 相同，`ReplacingMergeTree` 会收敛，影响可以忽略。
4. 用 `ingest_secret` 计算签名，用 `crypto.timingSafeEqual` 比较；不匹配时再用 `ingest_secret_prev` 试一次（支持轮换灰度期）。

密钥轮换：后台生成新密钥时，旧密钥自动移入 `ingest_secret_prev` 并保留 7 天，前端灰度完成后可手动清除。

#### 8.1.3 前端上报示例（TypeScript）

创建采集表后，后台直接展示以下可复制代码。前端可对 `INGEST_SECRET` 自由做常量拆分、字符串混淆或构建期注入。

```ts
// log-client.ts
export interface LogClientConfig {
  endpoint: string;   // https://log.example.com
  tableId: string;    // tbl_01KABCDEF...
  projectId: string;  // prj_01KABCDEF...
  secret: string;     // ingestSecret，可自行混淆
}

export type LogValue = string | boolean;

const encoder = new TextEncoder();
let cachedKey: Promise<CryptoKey> | null = null;

function importKey(secret: string): Promise<CryptoKey> {
  cachedKey ??= crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return cachedKey;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildEnvelope(
  config: LogClientConfig,
  data: Record<string, LogValue>,
): Promise<string> {
  const payload = JSON.stringify({
    recordId: crypto.randomUUID(),
    occurredAt: Date.now(),
    data,
  });

  const timestamp = Date.now();
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(8)).buffer);
  const signBase = `${config.projectId}\n${timestamp}\n${nonce}\n${payload}`;
  const signature = toHex(
    await crypto.subtle.sign('HMAC', await importKey(config.secret), encoder.encode(signBase)),
  );

  return JSON.stringify({ p: config.projectId, t: timestamp, n: nonce, s: signature, d: payload });
}

/** 常规上报。失败只记录，不抛出，避免影响业务流程。 */
export async function report(
  config: LogClientConfig,
  data: Record<string, LogValue>,
): Promise<boolean> {
  try {
    const body = await buildEnvelope(config, data);
    const res = await fetch(`${config.endpoint}/api/ingest/v1/tables/${config.tableId}/rows`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 页面卸载场景。sendBeacon 无法重试，属于尽力而为。 */
export async function reportOnUnload(
  config: LogClientConfig,
  data: Record<string, LogValue>,
): Promise<boolean> {
  const body = await buildEnvelope(config, data);
  const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
  return navigator.sendBeacon(`${config.endpoint}/api/ingest/v1/tables/${config.tableId}/rows`, blob);
}
```

使用：

```ts
const client: LogClientConfig = {
  endpoint: 'https://log.example.com',
  tableId: 'tbl_01KABCDEF...',
  projectId: 'prj_01KABCDEF...',
  secret: import.meta.env.VITE_LOG_SECRET,
};

await report(client, {
  user_id: '10086',
  login_method: 'sms',
  result: 'success',
  is_new_device: true,
});
```

注意 `Content-Type` 必须保持 `text/plain;charset=UTF-8`，改成 `application/json` 会触发 CORS 预检并使 `sendBeacon` 失效。

### 8.2 校验流程

1. 解析 envelope，校验 `p` / `t` / `n` / `s` / `d` 均存在且为期望类型。
2. 按 8.1.2 完成签名校验。
3. 校验 `tableId` 格式，从内存缓存读取当前表定义；缓存未命中时并发发出两条查询：`meta.collect_tables FINAL` 取表级属性，`meta.collect_fields FINAL WHERE status = 'active'` 取字段白名单。
4. 确认表状态为 `active`（`disabled` / `archived` 返回 `TABLE_DISABLED`，`creating` 返回 `TABLE_NOT_READY`）。
5. 校验 envelope 与 `d` 的大小、字段数量。
6. `JSON.parse(d)`，校验 `recordId` 为合法 UUID（缺省时由服务端生成）。
7. **校验 `occurredAt`**：必须是数字毫秒时间戳，且落在 `[now - 7d, now + 5min]`，否则返回 `INVALID_OCCURRED_AT`。该校验是 6.5 分区安全性的前提，不可省略。
8. 拒绝未知字段和已废弃的字段。
9. 校验必填字段。
10. 校验字符串和布尔类型。
11. 校验字符串最大长度。
12. 使用字段白名单构造 INSERT 列表。
13. 写入系统字段、Schema 版本和业务字段。

物理表名和列名不能使用普通 SQL 参数绑定，因此必须来自服务端白名单；所有字段值必须参数化。

### 8.3 响应

成功（HTTP 200）：

```json
{
  "success": true,
  "recordId": "bea94960-7fbe-4853-a689-8a309c471627",
  "requestId": "req_01K..."
}
```

失败（HTTP 4xx / 5xx），全站统一错误响应体：

```json
{
  "success": false,
  "error": {
    "code": "INVALID_FIELD_TYPE",
    "message": "field \"is_new_device\" expects boolean, got string",
    "field": "is_new_device",
    "expected": {
      "key": "is_new_device",
      "label": "是否新设备",
      "type": "boolean",
      "required": true
    },
    "schemaVersion": 7
  },
  "requestId": "req_01K..."
}
```

**字段类错误必须回传该字段在当前 Schema 中的定义**（`error.expected` 直接取自 `meta.collect_fields` 中该字段的 `active` 行）。因为校验依据完全来自建表时配置的字段，把这份定义连同错误一起返回，前端不用翻后台文档就能立刻知道该传什么；这也是不建失败统计表的前提——错误本身已经自解释。适用于 `UNKNOWN_FIELD`、`DEPRECATED_FIELD`、`REQUIRED_FIELD_MISSING`、`INVALID_FIELD_TYPE`、`FIELD_VALUE_TOO_LONG`。

`UNKNOWN_FIELD` 没有对应定义，此时 `expected` 省略，改为在 `message` 中列出当前允许的字段 Key 列表（受 `maxFields` 截断）。

`error.field` 仅在错误与某个具体字段相关时出现。`requestId` 由 Fastify 在请求入口生成（ULID），贯穿全部结构化日志，响应中原样返回，便于用户报障时定位。

错误码与 HTTP 状态映射：

| HTTP | 错误码 |
|---:|---|
| 400 | `INVALID_JSON`、`INVALID_ENVELOPE`、`INVALID_TABLE_ID`、`INVALID_RECORD_ID`、`INVALID_OCCURRED_AT`、`UNKNOWN_FIELD`、`DEPRECATED_FIELD`、`REQUIRED_FIELD_MISSING`、`INVALID_FIELD_TYPE`、`FIELD_VALUE_TOO_LONG`、`TOO_MANY_FIELDS`、`INVALID_QUERY`、`CONFIRMATION_REQUIRED` |
| 401 | `INVALID_SIGNATURE`、`SIGNATURE_EXPIRED`、`REPLAYED_NONCE`、`UNAUTHORIZED`、`TOKEN_EXPIRED`、`INVALID_CREDENTIALS`、`INVALID_CAPTCHA` |
| 403 | `FORBIDDEN`、`TABLE_DISABLED` |
| 404 | `TABLE_NOT_FOUND`、`FIELD_NOT_FOUND`、`USER_NOT_FOUND` |
| 409 | `USERNAME_EXISTS`、`FIELD_KEY_EXISTS`、`FIELD_KEY_RETIRED`、`TABLE_STATE_CONFLICT`、`LAST_SUPER_ADMIN` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR`、`INSERT_FAILED` |
| 503 | `TABLE_NOT_READY`、`CLICKHOUSE_UNAVAILABLE` |

### 8.4 写入策略

不在 Node 内存中攒批，攒批交给 ClickHouse 服务端的 async insert 完成。

**原理**：请求到达 ClickHouse 后，数据先进入服务端内存 buffer，buffer 按 `(查询文本, settings, 用户, 表)` 分组；当 buffer 达到 `async_insert_max_data_size` 或距首次写入超过 `async_insert_busy_timeout_max_ms` 时，整个 buffer 合并成**一个 part** 落盘。`wait_for_async_insert=1` 让 HTTP 响应挂起到 part 真正落盘才返回。

由此得出两条硬性要求：

- **每次 INSERT 必须使用该表的完整列集合**，未提交的字段显式写 `NULL`。因为 buffer 是按查询文本分组的，按实际提交字段动态拼列名会把攒批打散成几十个队列，part 数暴涨。
- **参数值必须走数据通道**（CH Node Client 的 `insert()` 传 `JSONEachRow` 行数组），不能拼进查询文本，否则每行都是不同的查询文本，攒批彻底失效。

上报路径的 query-level settings：

```ts
await client.insert({
  table: `data.${physicalName}`,
  values: [row],
  format: 'JSONEachRow',
  clickhouse_settings: {
    async_insert: 1,
    wait_for_async_insert: 1,
    async_insert_busy_timeout_max_ms: 1000,
    async_insert_max_data_size: '1048576',
  },
});
```

`async_insert_busy_timeout_max_ms` 取 1000ms 是刻意的取舍：默认约 200ms 会产生约 5 parts/s 的落盘频率，后台 merge 压力大；放宽到 1s 让 part 数下降约 5 倍，代价是 ingest 请求 p99 延迟约 1s。由于上报是异步旁路调用，这个延迟对业务无感。

其他：

- `_occurred_at` 由前端以毫秒数字传入，服务端转换为 `'YYYY-MM-DD HH:MM:SS.sss'`（UTC）写入。
- `_received_at` 由 ClickHouse `now64(3)` 生成，客户端不可控。
- V1 只支持单行上传；后续可以增加批量接口。
- 前端需要自行处理失败重试，重试必须复用同一个 `recordId`。
- 页面退出场景使用 `sendBeacon`（不可重试）或 `fetch keepalive`。

### 8.5 幂等边界

调用方必须为每一行生成稳定的 `recordId`，重试时保持不变。

`data.collect_*` 使用 `ReplacingMergeTree(_received_at)`，去重键包含 `_record_id`。同一 `recordId` 的重复写入会在后台 merge 时收敛为一行。但要理解两点限制：

1. **收敛不是实时的。** merge 由 ClickHouse 后台调度，查询不加 `FINAL`，因此短期内可以查到重复行。
2. **跨分区不收敛。** ReplacingMergeTree 只在分区内去重。由于分区键基于客户端固定的 `_occurred_at`，正常重试不会跨分区，但如果调用方在重试时修改了 `occurredAt`，去重就会失效。

结论：V1 提供**尽力去重，不承诺 Exactly Once**，精确计数不是本系统的目标（见 2.1）。**前端应自行做本地去重**，避免同一事件重复发送。

如果未来业务真的需要严格全局去重，需要引入专门的幂等存储或 `ReplicatedMergeTree` + Keeper（后者才有块级 `insert_deduplicate`，普通 `MergeTree` 完全没有这个能力）。

## 9. 查询与统计

### 9.1 查询原则

- 管理前端不能提交原始 SQL。
- Node 根据当前 Schema 的物理字段白名单生成 SQL，字段名只能来自白名单。
- 所有查询必须包含时间范围，且不超过配置的最大跨度。
- 限制返回行数、查询耗时和并发数（见附录 A）。
- 明细列表使用游标分页，不使用大 OFFSET。游标是 `(_occurred_at, _record_id)` 的 keyset，编码为不透明 Base64 串。
- 查询一律不加 `FINAL`（见 2.1 与 8.5）。
- 明细查询**不使用 `SELECT *`**，由服务端按当前 Schema 展开显式列名。这样宽表加列后查询开销不会失控，且能自动隐藏已废弃字段。

### 9.2 时区处理

物理存储一律 UTC。但所有**按时间粒度聚合**的接口必须接收时区参数，否则国内用户的“今天”会从早上 8 点开始：

```sql
-- 错误：固定 UTC
SELECT toDate(_occurred_at) AS bucket, count() ...

-- 正确：时区由前端传入
SELECT toStartOfDay(_occurred_at, {tz:String}) AS bucket, count() ...
```

- 按天：`toStartOfDay(_occurred_at, {tz:String})`
- 按小时：`toStartOfHour(_occurred_at, {tz:String})`（`+05:30` 这类半小时时区必须传，不能省）
- 按分钟：`toStartOfMinute(_occurred_at)`

前端传 IANA 时区名（如 `Asia/Shanghai`），由 Pinia 中的全局设置统一提供，默认取浏览器 `Intl.DateTimeFormat().resolvedOptions().timeZone`。

### 9.3 字段操作符

字符串：

- 等于、不等于
- 属于、不属于
- 包含、不包含
- 为空、不为空（区分 `NULL` 与空字符串，见 6.6）

布尔：

- 等于 `true`
- 等于 `false`
- 未提交，即 `IS NULL`

条件支持嵌套 `AND` 和 `OR`，但限制最大条件数量和嵌套层级（见附录 A）。

### 9.4 V1 统计能力

由于系统不再有 `_user_id` 之类的固定语义字段，统计能力全部构建为**对任意业务字段的通用操作**：

- 总上报行数
- 按分钟、小时、天的上报趋势（带时区）
- **任意字符串字段的去重计数** —— 用户数、会话数、设备数都由此表达，取决于建表时定义了什么字段
- 字符串字段分组与 Top N
- 布尔字段真假占比
- 多字段交叉筛选
- **按任意字段过滤 + 按时间排序的明细时间线** —— 取代原“用户时间线”，更通用
- 原始行明细
- CSV 流式导出

示例：登录成功次数

```sql
SELECT count()
FROM data.collect_a8f31c
WHERE _occurred_at >= {start:DateTime64(3)}
  AND _occurred_at < {end:DateTime64(3)}
  AND result = 'success';
```

示例：登录方式分布

```sql
SELECT login_method, count() AS total
FROM data.collect_a8f31c
WHERE _occurred_at >= {start:DateTime64(3)}
  AND _occurred_at < {end:DateTime64(3)}
  AND login_method IS NOT NULL
GROUP BY login_method
ORDER BY total DESC
LIMIT 50;
```

示例：某字段的去重计数（例如自定义的 `user_id` 字段）

```sql
SELECT uniqExact(user_id) AS unique_values
FROM data.collect_a8f31c
WHERE _occurred_at >= {start:DateTime64(3)}
  AND _occurred_at < {end:DateTime64(3)}
  AND user_id IS NOT NULL
  AND user_id != '';
```

必须同时排除 `NULL` 和空字符串，否则“未提交”和“提交了空串”会被当成一个有效取值计入。

示例：按任意字段过滤的明细时间线

```sql
SELECT `_record_id`, `_occurred_at`, `user_id`, `login_method`, `result`, `is_new_device`
FROM data.collect_a8f31c
WHERE user_id = {value:String}
  AND _occurred_at >= {start:DateTime64(3)}
  AND _occurred_at < {end:DateTime64(3)}
ORDER BY _occurred_at DESC, _record_id DESC
LIMIT 100;
```

列名由服务端按当前 Schema 白名单展开。由于业务字段不在排序键中，这类查询会在时间范围内扫描，V1 数据量下可以接受。

### 9.5 CSV 导出

采用**流式导出**，不在 Node 内存中缓冲整个结果集：

1. 以 `FORMAT CSVWithNames` 向 ClickHouse 发起查询。
2. 将 CH 返回的可读流直接 pipe 到 HTTP 响应，配合 `Content-Disposition: attachment`。
3. 设置服务端硬上限（见附录 A）；超限时截断并在最后一行追加注释说明，同时在响应头 `X-Export-Truncated: 1` 标记。
4. 导出查询使用 `ch_readonly` 账户，并附带 `max_execution_time` 与 `max_result_rows` 限制。

### 9.6 数据量增长后的优化预留

数据量增长后，可以为高频过滤字段增加数据跳数索引，为固定仪表盘增加小时或天级物化聚合表。V1 不提前创建这些结构。

## 10. 管理后台

### 10.1 页面

1. 登录页（用户名 + 密码 + 图形验证码）
2. 数据概览
3. 数据采集表列表
4. 创建数据采集表
5. 字段配置与 Schema 版本
6. 上报接入文档（含密钥与可复制的 TypeScript 示例）
7. 数据明细查询
8. 统计分析
9. 账户管理

### 10.2 数据概览

- 今日总上报量（按用户时区）
- 最近 24 小时趋势
- 各数据采集表上报量
- 最近上报时间

不做“上传失败数量”卡片。上报失败不落库，只写结构化日志（见 12.4），排查时按 `requestId` 或 `tableId` 检索日志即可。

### 10.3 数据采集表详情

- 基本信息、公开 `tableId` 与 `projectId`
- 表状态与状态迁移操作
- 当前 Schema 版本
- 字段列表
- 字段操作：新增、改名、改类型、软废弃、物理删除
- 上报密钥查看与轮换
- 最近上报记录
- 接入示例代码（可一键复制）
- 统计分析入口

### 10.4 高危操作的交互要求

以下操作会造成**历史数据永久丢失**，必须在 UI 上做强提示与两级确认：

- 物理删除字段
- 修改字段类型（实现为删除后重建，见 7.3）

交互规范：

1. 按钮使用危险色（Element Plus `type="danger"`），且不能是列表行内的默认操作，必须收进「更多」菜单。
2. 第一级确认：弹窗标题明确写「此操作将永久删除该字段的全部历史数据」，正文列出字段 `key`、`label`、类型，以及该字段当前的非空行数（实时查询 `count()`），让操作者看到具体会丢多少数据。
3. 第二级确认：要求用户**手动输入字段 Key** 完全一致才能激活确认按钮，不允许复制粘贴之外的快捷通过。
4. 提交时请求体必须携带 `confirm` 字段，值等于字段 Key，服务端二次校验，不一致返回 `CONFIRMATION_REQUIRED`。
5. 操作完成后的成功提示中，再次说明「该字段 Key 已标记退役，永久不可重新创建」。

字段重命名不丢数据，只需一级确认，但必须提示「前端上报代码需同步改用新字段名，否则该字段的上报会被拒绝」。

## 11. 账户与权限

### 11.1 角色

V1 三个角色，层级递减：

- `super_admin`：由 bootstrap 创建，系统最高权限
- `admin`：日常管理员
- `user`：只读账户

### 11.2 权限矩阵

| 操作 | user | admin | super_admin |
|---|---:|---:|---:|
| 查看全部数据采集表 | 是 | 是 | 是 |
| 查询全部数据 | 是 | 是 | 是 |
| 导出数据 | 是 | 是 | 是 |
| 修改自己的密码 | 是 | 是 | 是 |
| 创建数据采集表 | 否 | 是 | 是 |
| 新增 / 改名 / 废弃字段 | 否 | 是 | 是 |
| 物理删除字段、修改字段类型 | 否 | 是 | 是 |
| 查看与轮换上报密钥 | 否 | 是 | 是 |
| 变更表状态 | 否 | 是 | 是 |
| 创建 `user` 账户 | 否 | 是 | 是 |
| 创建 `admin` 账户 | 否 | 否 | 是 |
| 删除 `user` 账户 | 否 | 是 | 是 |
| 删除 `admin` 账户 | 否 | **否（平级不可删）** | 是 |
| 删除 `super_admin` 账户 | 否 | 否 | 否 |

补充约束：

- 账户删除是**物理删除**，不保留软删除标记。需要时重新创建同名账户即可。
- `super_admin` 账户任何人都不能删除，包括其自身，避免系统失去最高权限出口。
- 系统必须始终保留至少一个 `status = 'active'` 的 `super_admin`；试图禁用最后一个时返回 `LAST_SUPER_ADMIN`。
- 鉴权基于 Bearer Token 中携带的角色，**不依赖 URL 路径前缀**，`/api/admin/*` 只是命名约定，每个路由独立声明所需角色。

### 11.3 认证

- **Bearer Token**：登录成功返回 JWT（HS256，密钥来自 `JWT_SECRET` 环境变量），有效期 12 小时，前端存内存 + `sessionStorage`，通过 `Authorization: Bearer <token>` 携带。
- **无 Cookie，因此不存在 CSRF 风险**，管理接口不需要 CSRF Token。
- **图形验证码**：登录前先取验证码，验证码 ID 与答案存进程内 Map，TTL 2 分钟，**一次性消费**（无论校验成功或失败都立即删除，避免爆破同一张图）。
- 登录接口独立限流（见附录 A），防止撞库。
- 登出由前端丢弃 Token 实现；Token 过期返回 `TOKEN_EXPIRED`，前端跳转登录页。

```text
GET  /api/auth/captcha   →  { captchaId, image }   # image 为 SVG 或 PNG 的 data URI
POST /api/auth/login     ←  { username, password, captchaId, captchaCode }
                         →  { token, expiresIn, user: { username, role } }
```

### 11.4 初始账户

首次启动时通过环境变量创建初始 `super_admin`：

```text
BOOTSTRAP_ADMIN_USERNAME
BOOTSTRAP_ADMIN_PASSWORD
```

仅当 `meta.app_users` 中不存在任何 `super_admin` 时执行。初始化成功后应删除明文密码环境变量或完成密码轮换。

## 12. 安全与稳定性

### 12.1 上传接口

- `tableId` 与 `projectId` 是路由与签名主体标识，**不是秘密**。
- 真正的防护是 8.1 的 HMAC 签名，定位为 anti-casual-abuse，**不是身份认证**。
- **上报数据全部为不可信输入。** 任何上报字段（包括自定义的用户标识字段）都不构成身份证明，禁止用于权限判断。
- 支持项目来源域名白名单，但必须理解 `Origin` 头只对浏览器有约束力，非浏览器客户端可任意伪造，它是纵深防御的一层而非依赖项。
- CORS 配置为白名单 Origin；上报接口保持 CORS 简单请求形态（`text/plain`，无自定义头），避免预检。
- 按 IP 和 `tableId` 限流（进程内令牌桶，重启后重置，V1 可接受）。
- 限制请求体大小、字段数量和单字段长度（见附录 A）。
- 强制 `occurredAt` 时间窗校验，防止伪造时间戳导致分区膨胀（见 6.5 与 8.2）。
- 禁止用户控制数据库名、物理表名和任意列名。
- 上传使用 `ch_ingest` 账户，只有目标 `data` 数据库的 INSERT 权限。

### 12.2 查询接口

- 使用 `ch_readonly` 账户。
- 设置 `max_execution_time`、`max_memory_usage` 和 `max_result_rows`。
- 所有值使用参数化查询。
- 字段名只能来自当前表 Schema 白名单。
- 不向前端开放 SQL 控制台。
- 显式固定 `optimize_move_to_prewhere_if_final = 0`，禁止把版本相关列写进 `PREWHERE`。

### 12.3 管理接口

- 密码使用 Argon2id。
- 禁止普通账户访问 DDL 和账户接口，鉴权基于 Token 中的角色。
- DDL 与元数据写入全部经过 `serial()` 串行队列（见 3.3.1）。
- **不做审计日志表。** 字段定义与 Schema 版本本身就记录了“表被改成了什么样”，`meta.collect_tables` 的版本链天然可回溯每次变更的结果状态；额外的操作流水在 V1 收益不足以抵消维护成本。需要追溯“谁改的”时，看结构化日志。

### 12.4 日志与可观测性

不建任何日志表，全部走 **stdout 结构化 JSON 日志**（Fastify 内置 pino）：

- 每条日志携带 `requestId`、`route`、`statusCode`、`durationMs`。
- 上报失败额外携带 `tableId`、`errorCode`、`field`、`schemaVersion`。这是排查“前端埋点写错导致数据静默丢失”的唯一手段，**必须完整输出，不能只记一个 400**。
- 元数据变更携带 `operator`（用户名）、`tableId`、`operation`、`schemaVersion`。
- reconcile 结果单独一条 `level=warn` 以上的汇总日志。

慢查询、小 part 数量和压缩情况通过 ClickHouse 的 `system.query_log`、`system.parts` 和 `system.parts_columns` 观察。

### 12.5 健康检查

```text
GET /healthz
```

```json
{
  "status": "ok",
  "uptimeSeconds": 38122,
  "clickhouse": "ok",
  "lastReconcile": { "at": "2026-08-24T02:11:03.219Z", "fixed": 0, "failed": 0 }
}
```

- `clickhouse` 通过 `SELECT 1` 探测，失败时整体 `status` 为 `degraded`，HTTP 返回 503。
- 该接口不需要认证，但不暴露任何表名、字段名或版本号之外的内部信息。

## 13. 性能策略

V1 数据量不大，优先保证结构简单和行为正确。

- 业务字段使用明确物理列，避免 JSON 查询时的类型推断开销。
- 按月分区，便于时间范围查询和未来的数据保留策略。
- 排序键 `(toDate(_occurred_at), _occurred_at, _record_id)` 服务于时间范围查询与去重收敛。
- 使用 ClickHouse 服务端 async insert 合并小请求，并按 8.4 调优 part 落盘频率。
- 每次 INSERT 使用完整列集合，保证 async insert 攒批不被打散。
- Node 使用进程内 Map 缓存表元数据，不引入 Redis；字段变更后立即失效对应缓存。缓存值是「表属性 + active 字段白名单」的合并结果，上报路径命中缓存时不产生任何 ClickHouse 查询。
- 不为每个字符串字段创建额外索引；确有热点过滤字段时再评估数据跳数索引。
- 低基数字符串是否改为 `LowCardinality(String)`，以后根据真实基数和查询情况决定，不作为 V1 字段类型暴露。

## 14. 数据保留与删除

### 14.1 默认策略

V1 默认永久保留采集数据，管理页面不提供行级物理删除。

后续可增加每张数据采集表的保留周期，并通过 TTL 实现：

```sql
TTL _occurred_at + INTERVAL 180 DAY DELETE
```

TTL 变更属于高风险操作，需要二次确认。

数据采集表的“删除”是归档；字段的删除见 5.3（软废弃或物理删除）；账户删除是物理删除。

### 14.2 运维级数据清理（Runbook）

上报接口是无认证写入，一旦密钥泄露或前端埋点写错，可能灌入大量垃圾数据；也可能因敏感信息或法律要求需要清理特定行。这类场景**不通过管理后台**，作为独立的高权限运维流程执行：

1. 先用只读账户确认影响范围：`SELECT count() FROM data.<table> WHERE <条件>`。
2. 使用 `ch_meta` 账户执行轻量删除：

```sql
DELETE FROM data.collect_a8f31c
WHERE _occurred_at >= '2026-08-01 00:00:00.000'
  AND _occurred_at <  '2026-08-02 00:00:00.000'
  AND user_id = 'bad_actor';
```

3. 整月数据作废时优先使用 `ALTER TABLE ... DROP PARTITION '202608'`，代价远低于逐行删除。
4. 清理前后各记录一条结构化日志，包含执行人、条件和影响行数。
5. 若原因是密钥泄露，同步执行密钥轮换（见 8.1.2）。

## 15. API 草案

### 15.1 认证

```text
GET    /api/auth/captcha
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/auth/change-password        # 修改自己的密码
```

### 15.2 账户

```text
GET    /api/admin/users
POST   /api/admin/users                 # 创建 admin 需要 super_admin
POST   /api/admin/users/:username/reset-password
POST   /api/admin/users/:username/status
DELETE /api/admin/users/:username       # 物理删除，权限见 11.2
```

账户接口以 `username` 寻址，与 `meta.app_users` 的去重键保持一致，避免每次操作都要反查。

### 15.3 数据采集表

```text
GET    /api/admin/tables
POST   /api/admin/tables
GET    /api/admin/tables/:tableId
POST   /api/admin/tables/:tableId/retry            # failed → creating，幂等重试
POST   /api/admin/tables/:tableId/status           # 状态迁移，见 5.1
GET    /api/admin/tables/:tableId/secret           # 查看当前上报密钥
POST   /api/admin/tables/:tableId/secret/rotate    # 轮换密钥
```

### 15.4 字段

```text
POST   /api/admin/tables/:tableId/fields                          # 新增
PATCH  /api/admin/tables/:tableId/fields/:fieldKey                # 改 label / description / required
POST   /api/admin/tables/:tableId/fields/:fieldKey/rename         # 改 key，数据保留
POST   /api/admin/tables/:tableId/fields/:fieldKey/retype         # 改类型，高危，数据丢失
POST   /api/admin/tables/:tableId/fields/:fieldKey/deprecate      # 软废弃
DELETE /api/admin/tables/:tableId/fields/:fieldKey                # 物理删除，高危
GET    /api/admin/tables/:tableId/fields/:fieldKey/usage          # 该字段非空行数，供确认弹窗展示
```

`retype` 与 `DELETE` 的请求体必须携带 `confirm`，值等于 `fieldKey`。

### 15.5 上传

```text
POST   /api/ingest/v1/tables/:tableId/rows
```

### 15.6 查询和统计

```text
POST   /api/admin/tables/:tableId/query        # 明细，游标分页
POST   /api/admin/tables/:tableId/statistics   # 趋势 / 分组 / 去重计数，必带 tz
POST   /api/admin/tables/:tableId/export       # CSV 流式导出
```

### 15.7 系统

```text
GET    /healthz
```

## 16. 非目标

V1 明确不包含：

- 官方 npm SDK 包（只提供可复制的示例代码）
- 自动页面浏览、点击或曝光采集
- 提交后编辑历史行
- 审批流程和表单草稿
- 审计日志表
- 上报失败的落库统计
- 严格 Exactly Once
- 数值字段聚合
- 数组和嵌套数据
- 枚举选项管理
- 多租户项目权限
- 跨数据采集表 Join
- 漏斗、留存和路径分析
- 实时告警
- 自定义 SQL
- Redis、Kafka、PostgreSQL、MySQL、SQLite

## 17. 验收标准

### 17.1 创建和变更

- 管理员可以创建只包含字符串和布尔字段的数据采集表。
- 创建成功后返回 `tableId`、`projectId`、`ingestSecret` 和可直接运行的 TypeScript 示例。
- 可以新增字段，新字段对历史行表现为 `NULL`。
- 可以软废弃字段，历史数据仍可查询。
- 可以重命名字段，历史数据完整保留在新字段名下，旧 Key 在 `meta.collect_fields` 中留存为 `renamed` 并指向新 Key。
- 可以物理删除字段和修改字段类型，两者都需要输入字段 Key 二次确认，且历史数据确实被清除。
- 任何已退役的 Key 都无法重新创建，返回 `FIELD_KEY_RETIRED`。

### 17.2 上传

- 业务前端仅通过 HTTP 接口主动上传，签名正确才被接受。
- 签名错误、过期、重放分别返回 `INVALID_SIGNATURE`、`SIGNATURE_EXPIRED`、`REPLAYED_NONCE`。
- 合法请求能写入对应物理表的一行。
- 未知字段、废弃字段、错误类型和缺少必填字段会被拒绝，**错误响应必须指明具体字段名与期望类型**。
- `occurredAt` 超出 `[now-7d, now+5min]` 被拒绝。
- 接口成功响应表示 ClickHouse 已确认 part 落盘。
- 使用 `sendBeacon` 从跨域页面上报能够成功，不产生 CORS 预检。

### 17.3 查询

- 所有登录用户可以查看所有数据采集表和数据。
- 支持时间范围、字符串、布尔字段的组合筛选。
- 支持上报趋势、任意字符串字段的去重计数与分组、按任意字段过滤的明细时间线。
- 按天聚合的结果随传入时区变化而正确变化。
- 查询 API 不接受任意 SQL、物理表名或未注册字段名。
- CSV 导出为流式，超过上限时正确截断并标记。

### 17.4 账户

- `super_admin` 可以创建和删除 `admin` 与 `user`。
- `admin` 可以创建和删除 `user`，但不能创建或删除其他 `admin`。
- 任何角色都不能删除 `super_admin`。
- 禁用最后一个 active `super_admin` 返回 `LAST_SUPER_ADMIN`。
- 登录必须通过图形验证码，同一验证码无法使用两次。
- 所有用户都能修改自己的密码。

### 17.5 并发与恢复（负向用例）

- 并发提交两个同名账户创建请求，只有一个成功，另一个返回 `USERNAME_EXISTS`。
- 并发提交两个新增字段请求，两个字段都成功落地，`schema_version` 连续递增，不发生覆盖丢失。
- 同一 `recordId` 重试多次，后台 merge 完成后表中只剩一行。
- 在“物理表已创建、`active` 元数据未写入”之间 kill 进程，重启后 reconcile 自动把表收敛为 `active`。
- 手动在 ClickHouse 中删掉某个已注册的列，重启后 reconcile 自动补回该列并记录日志。

## 18. 后续演进

按实际需求逐步增加，不提前实现：

1. `number` 字段，映射为 `Nullable(Float64)`。
2. 批量上传接口。
3. 小时和天级聚合表。
4. 高频过滤字段的数据跳数索引。
5. 数据表 TTL。
6. 表级查看权限。
7. 严格幂等存储（`ReplicatedMergeTree` + Keeper，或独立幂等表）。
8. 多 Node 实例和 PostgreSQL 元数据存储。
9. 高流量下的消息队列。

## 附录 A：限额配置

所有限额**写在配置文件里，不入库**，随部署环境调整，通过环境变量覆盖。

```ts
// src/config/limits.ts
export const limits = {
  ingest: {
    maxBodyBytes: 64 * 1024,        // envelope 整体大小上限
    maxPayloadBytes: 32 * 1024,     // 解码后 d 字段大小上限
    maxFields: 100,                 // 单次上报字段数上限
    maxStringLength: 4096,          // 单个字符串字段长度上限
    occurredAtPastMs: 7 * 24 * 3600 * 1000,
    occurredAtFutureMs: 5 * 60 * 1000,
    signatureWindowMs: 5 * 60 * 1000,
    nonceCacheSize: 100_000,
    rateLimitPerIp: 100,            // 每秒
    rateLimitPerTable: 1000,        // 每秒
  },
  query: {
    maxRangeDays: 92,
    maxRows: 10_000,
    maxConditions: 32,
    maxNestingDepth: 4,
    maxExecutionTimeSec: 10,
    maxMemoryUsageBytes: 2 * 1024 * 1024 * 1024,
    maxConcurrent: 8,
  },
  export: {
    maxRows: 1_000_000,
    maxExecutionTimeSec: 120,
    maxConcurrent: 2,
  },
  auth: {
    tokenTtlSec: 12 * 3600,
    captchaTtlSec: 120,
    loginRateLimitPerIp: 10,        // 每分钟
  },
  schema: {
    maxFieldsPerTable: 500,
  },
} as const;
```

## 附录 B：环境变量

```text
# 服务
PORT
LOG_LEVEL

# ClickHouse（三个账户，见 3.4）
CLICKHOUSE_URL
CLICKHOUSE_INGEST_USER
CLICKHOUSE_INGEST_PASSWORD
CLICKHOUSE_META_USER
CLICKHOUSE_META_PASSWORD
CLICKHOUSE_READONLY_USER
CLICKHOUSE_READONLY_PASSWORD

# 认证
JWT_SECRET

# 初始账户，仅首次启动使用
BOOTSTRAP_ADMIN_USERNAME
BOOTSTRAP_ADMIN_PASSWORD

# CORS
INGEST_ALLOWED_ORIGINS
CONSOLE_ALLOWED_ORIGINS
```
