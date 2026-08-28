## 6. ClickHouse 数据设计

### 6.1 存储划分

ClickHouse 只保留一个库：

```sql
CREATE DATABASE IF NOT EXISTS data;
```

管理数据在 SQLite（`$DATA_DIR/sqlite3/app.db`），业务上报数据在 ClickHouse 的 `data` 库。
下面 6.2 / 6.3 / 6.4 是 SQLite 表，6.5 / 6.6 是 ClickHouse 表。

### 6.2 账户元数据表

```sql
CREATE TABLE IF NOT EXISTS app_users
(
    user_id       TEXT    NOT NULL PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('super_admin', 'admin', 'user')),
    status        TEXT    NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
) STRICT;
```

说明：

- `username` 的唯一性由 `UNIQUE` 约束保证，**不再由应用层先查后写**。并发创建同名账户时，
  第二条会撞上约束报错，应用层捕获后翻译为 `USERNAME_EXISTS`。
- 密码只保存 Argon2id 哈希。
- `role` 与 `status` 的取值由 `CHECK` 兜底，应用层仍然要校验以便返回友好错误。
- 时间统一存 ISO 8601 UTC 字符串（`2026-08-27T02:11:03.219Z`）。
- 账户删除是**物理删除**（`DELETE FROM app_users WHERE username = ?`），不做软删除。需要时重新创建同名账户即可。
- 因为账户会被物理删除，`collect_tables.created_by` 只保存用户名字符串快照，仅用于展示，不构成外键。

读取当前账户：

```sql
SELECT * FROM app_users WHERE username = ? AND status = 'active';
```

账户更新就是普通 `UPDATE`，包在 `BEGIN IMMEDIATE` 事务内。不再有 `version` 列、不再有
`FINAL`、不再有 `PREWHERE` 陷阱——这些都是 V2 为了绕开 ClickHouse 缺陷而存在的，
迁到 SQLite 后一并消失。

### 6.3 数据采集表元数据

```sql
CREATE TABLE IF NOT EXISTS collect_tables
(
    project_id                    TEXT    NOT NULL PRIMARY KEY,
    physical_name                 TEXT    NOT NULL UNIQUE,
    display_name                  TEXT    NOT NULL,
    description                   TEXT    NOT NULL DEFAULT '',
    status                        TEXT    NOT NULL
        CHECK (status IN ('creating', 'active', 'disabled', 'archived', 'failed')),
    schema_version                INTEGER NOT NULL,
    ingest_secret                 TEXT    NOT NULL,
    ingest_secret_prev            TEXT    NOT NULL DEFAULT '',
    ingest_secret_prev_expires_at TEXT,
    created_by                    TEXT    NOT NULL,
    created_at                    TEXT    NOT NULL,
    updated_at                    TEXT    NOT NULL
) STRICT;
```

说明：

- `project_id` 是**唯一的**公开 ID，例如 `prj_01KABCDEF...`：既用于路由定位，也是上报签名的主体。
  **一个项目就是一张采集表**，不再区分「表 ID」与「项目 ID」——两个永远一一对应的 ID 只会带来
  命名混淆、一次多余的一致性校验，以及「同一个值在代码里有两个名字」的长期负担。
- `physical_name` 由服务端生成，例如 `collect_a8f31c...`，永远不使用用户输入。
- `ingest_secret` / `ingest_secret_prev` 支持密钥轮换期间双密钥并存；
  `ingest_secret_prev_expires_at` 记录旧密钥的失效时刻（轮换时置为 7 天后，见 8.1.2），
  为 `NULL` 表示当前没有处于灰度期的旧密钥。
- `physical_name` 是 `UNIQUE`，杜绝物理表名撞车；`project_id` 作为主键天然唯一。
- 本表**只保存表级属性，不保存字段定义**。字段是独立实体，见 6.4。
- 不再有 `version` 列：SQLite 有事务，状态迁移就是普通 `UPDATE`，不需要追加版本行来模拟。

公开 ID 不是密钥，不能作为安全认证凭据。

### 6.4 字段元数据表

```sql
CREATE TABLE IF NOT EXISTS collect_fields
(
    project_id     TEXT    NOT NULL REFERENCES collect_tables(project_id),
    field_key      TEXT    NOT NULL,
    label          TEXT    NOT NULL,
    type           TEXT    NOT NULL CHECK (type IN ('string', 'boolean')),
    required       INTEGER NOT NULL CHECK (required IN (0, 1)),
    description    TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL
        CHECK (status IN ('active', 'deprecated', 'dropped', 'renamed')),
    renamed_to     TEXT    NOT NULL DEFAULT '',
    schema_version INTEGER NOT NULL,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    PRIMARY KEY (project_id, field_key)
) STRICT;
```

**一个字段一行。** 这与 2. 产品定义中“业务字段展开为物理列、不用 JSON 兜底”的原则一致——把 N 个字段挤进一个 `fields_json` 字符串列会导致：改一个 label 要读写整个字段数组、每个版本行复制一份全量定义、以及数据库完全无法参与字段维度的查询。字段是独立实体，就该独立成行。

字段说明：

- `(project_id, field_key)` 是**主键**，因此同一张表内 Key 天然唯一，且退役 Key 的复用会被数据库
  直接拒绝——V2 里需要应用层「先 count 再决定」的那一步彻底消失，连带消除了并发窗口。
- `status` 取值：

| status | 含义 | 物理列 | 历史数据 | 可上报 |
|---|---|---|---|---|
| `active` | 正常 | 在 | 在 | 是 |
| `deprecated` | 软废弃 | 在 | 在 | 否 |
| `dropped` | 物理删除 | 已删 | 已丢失 | 否 |
| `renamed` | 已重命名 | 已改名 | 在（新 Key 下） | 否 |

- `renamed_to`：仅 `status = 'renamed'` 时有值，指向新 Key，用于追溯历史变更链。
- `schema_version`：本次变更完成后表的 Schema 版本，用于解释“这个字段是从哪个版本开始存在/停止存在的”。
- **退役即 tombstone**：`(project_id, field_key)` 只要存在任何一行，该 Key 就不能再被创建，无需单独维护退役列表。

关键查询：

```sql
-- 当前有效字段（上报校验与查询白名单的唯一来源）
SELECT field_key, label, type, required, description
FROM collect_fields
WHERE project_id = ? AND status = 'active'
ORDER BY field_key;

-- 历史查询：允许显式选择已软废弃的字段
SELECT field_key, label, type
FROM collect_fields
WHERE project_id = ? AND status IN ('active', 'deprecated');
```

**不再需要「Key 是否可用」的预查询。** 直接 `INSERT`，撞上主键约束就说明该 Key 已被占用或已退役，
捕获后返回 `FIELD_KEY_RETIRED`。这比先查后写既少一次往返，又没有并发窗口。

拆表后新增的能力（`fields_json` 时代做不到）：跨表检索字段，例如「哪些采集表定义了 `user_id`」「全系统还有哪些字段没被废弃」，直接一条 SQL 即可，不必把所有表的定义拉到 Node 里解析。

字段变更只写受影响的那一行，不触碰同表其他字段。

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

