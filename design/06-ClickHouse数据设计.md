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
    type           TEXT    NOT NULL
        CHECK (type IN ('string', 'enum', 'boolean', 'integer', 'float', 'datetime')),
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

- `(project_id, field_key)` 是**主键**，因此同一张表内 Key 天然唯一，重复创建会被数据库直接拒绝——
  V2 里需要应用层「先 count 再决定」的那一步彻底消失，连带消除了并发窗口。
  重建 `dropped` / `renamed` 的 Key 时，先在同一个事务里 `DELETE` 掉那行墓碑再 `INSERT`（见 5.2 / 7.2），
  仍然不需要「先查后写」。
- `status` 取值：

| status | 含义 | 物理列 | 历史数据 | 可上报 |
|---|---|---|---|---|
| status | 含义 | 物理列 | 历史数据 | 可上报 | 可查询 | 可物理删除 | Key 可重建 |
|---|---|---|---|---|---|---|---|
| `active` | 正常 | 在 | 在 | 是 | 是（默认列） | 是 | — |
| `deprecated` | 软废弃 | 在 | 在 | 否 | 是（需显式选择，见 9.1） | 是 | 否，先删列 |
| `dropped` | 物理删除 | 已删 | 已丢失 | 否 | 否 | 否 | 是 |
| `renamed` | 已重命名 | 已改名 | 在（新 Key 下） | 否 | 否（用新 Key 查） | 否 | 是 |

- `renamed_to`：仅 `status = 'renamed'` 时有值，指向新 Key，用于追溯历史变更链。
- `schema_version`：本次变更完成后表的 Schema 版本，用于解释“这个字段是从哪个版本开始存在/停止存在的”。
- **退役即 tombstone**：`(project_id, field_key)` 只要存在任何一行，该 Key 就不能被**直接**创建；
  `dropped` / `renamed` 的墓碑允许在重建时清掉（见 5.2），`deprecated` 的不行——它名下的物理列还在。
  无论哪种情况都不需要单独维护一张退役列表。

关键查询：

```sql
-- 当前有效字段（上报校验白名单的唯一来源，也是 13 那个进程内缓存的内容）
SELECT field_key, label, type, required, description
FROM collect_fields
WHERE project_id = ? AND status = 'active'
ORDER BY field_key;

-- 历史查询：允许显式选择已软废弃的字段（见 9.1 的 includeFields）
SELECT field_key, label, type
FROM collect_fields
WHERE project_id = ? AND status IN ('active', 'deprecated')
ORDER BY field_key;

-- 管理后台的表详情：全部行，含墓碑（见 15.3）
SELECT field_key, label, type, required, description, status, renamed_to, schema_version
FROM collect_fields
WHERE project_id = ?
ORDER BY field_key;
```

**不再需要「Key 是否可用」的预查询。** 直接 `INSERT`，撞上主键约束就说明该 Key 已被占用或已退役，
捕获后返回 `FIELD_KEY_RETIRED`。这比先查后写既少一次往返，又没有并发窗口。

拆表后新增的能力（`fields_json` 时代做不到）：跨表检索字段，例如「哪些采集表定义了 `user_id`」「全系统还有哪些字段没被废弃」，直接一条 SQL 即可，不必把所有表的定义拉到 Node 里解析。

字段变更只写受影响的那一行，不触碰同表其他字段。

**`type` 的 `CHECK` 覆盖 5.4 的六种类型。** 注意 SQLite 无法 `ALTER` 掉一条 `CHECK` 约束，
新增类型意味着已部署的库要做一次表重建迁移——这是刻意保留的摩擦：类型是全系统的语义地基
（6.6 的物理列、8.2 的校验、9.3 的操作符、9.4 的指标都挂在它上面），加一个类型不应该是轻量动作。

#### 6.4.1 枚举选项表

```sql
CREATE TABLE IF NOT EXISTS collect_field_options
(
    project_id TEXT    NOT NULL,
    field_key  TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    label      TEXT    NOT NULL,
    status     TEXT    NOT NULL CHECK (status IN ('active', 'disabled')),
    sort_order INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    PRIMARY KEY (project_id, field_key, value),
    FOREIGN KEY (project_id, field_key)
        REFERENCES collect_fields(project_id, field_key) ON DELETE CASCADE
) STRICT;
```

**一个选项一行**，理由与 6.4「一个字段一行」完全同构：塞进 `collect_fields.options_json` 会导致
改一个选项的 `label` 要读写整个数组、并发改两个选项互相覆盖、以及数据库无法参与选项维度的查询
（「渠道字段现在有几个启用选项」「哪些字段登记了 `wechat`」）。

说明：

- `(project_id, field_key, value)` 是主键，`value` 在字段内天然唯一，重复提交被数据库直接拒绝。
- `value` **只允许在创建时确定**，此后不可修改：它就是写进 ClickHouse 列里的那个字符串，
  改了历史数据立刻对不上。要换值就新增一个选项、停用旧的。
- `sort_order` 决定管理后台下拉与图例的展示顺序，由提交列表的数组下标生成（见 15.4）。
- `ON DELETE CASCADE` 挂在 `(project_id, field_key)` 上：字段被物理删除、
  或整张采集表被删（7.5）时，选项行跟着消失，不留孤儿。这依赖 3.3.2 已经要求开启的
  `PRAGMA foreign_keys = ON`。
- 非 `enum` 字段在本表中**不允许有任何行**。`string` ⇄ `enum` 转换时，
  转成 `string` 的那一步要在同一个事务里删光该字段的选项行（见 7.3）。

关键查询：

```sql
-- 上报校验用的值域白名单（进入 13 的进程内缓存，与字段白名单同一份缓存值）
SELECT value
FROM collect_field_options
WHERE project_id = ? AND field_key = ? AND status = 'active';

-- 管理后台与查询构建器的选项下拉：全部行，含已停用（历史数据里还有它们）
SELECT value, label, status
FROM collect_field_options
WHERE project_id = ? AND field_key = ?
ORDER BY sort_order, value;
```

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
    `login_method`    LowCardinality(Nullable(String)),
    `result`          LowCardinality(Nullable(String)),
    `remember_me`   Nullable(Bool),
    `retry_count`     Nullable(Int64),
    `cost_seconds`    Nullable(Float64),
    `registered_at`   Nullable(DateTime64(3, 'UTC'))
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

系统字段只有四个，统一以 `_` 开头，业务字段禁止使用该前缀（5.2 的 Key 正则已保证）。

**`_` 之下那六列全部是业务自定义字段，一个都不是系统能力。** 本系统没有 SDK、不自动采集任何东西（见 2），
所以 `user_id` 叫什么、要不要记、`remember_me` 这个布尔值代表什么、`registered_at` 从哪来，
**全部由建表人定义、由业务代码自己算好传上来**。文档里反复出现的这套登录日志字段只是一个示例表，
换个业务就是另外一组完全不同的列。上例中 `login_method` / `result` 是 `enum`，`retry_count` 是 `integer`，
`cost_seconds` 是 `float`，`registered_at` 是 `datetime`（业务时间，与 `_occurred_at` 是两回事，见 5.4.1）。

设计要点：

- **`ReplacingMergeTree(_received_at)`**：同一 `_record_id` 的重试会在后台 merge 时收敛，保留 `_received_at` 最大的一条。查询**不加 `FINAL`**（宽表加 `FINAL` 代价过高），所以 merge 完成前可见重复，这与 2.1 的保证等级一致。
- **去重键与分区键都基于 `_occurred_at`**：`_occurred_at` 是前端传入的固定值，重试时完全相同，因此重试行必然落在同一分区、同一排序键上，去重才能生效。若分区键改用 `_received_at`，跨天或跨月重试就会落到不同分区而永远无法收敛。
- **分区键安全性的前提是时间窗校验**：`_occurred_at` 由客户端提供，如果不校验，伪造一个 2099 年的时间戳就能凭空创建一个分区，几十个伪造月份即可让表因 `Too many parts` 停止写入。因此 8.2 的 `occurredAt` 范围校验是**强制**的，不是可选项，它把分区跨度限制在两个相邻月份内。

### 6.6 自定义字段物理类型

类型集合与各自的能力见 5.4，本节只定义它们落到 ClickHouse 上是什么：

| 业务类型 | ClickHouse 类型 | 选它的理由 |
|---|---|---|
| `string` | `Nullable(String)` | 无约束的变长文本 |
| `enum` | `LowCardinality(Nullable(String))` | 值域受控，字典编码；不用 CH `Enum`，理由见 5.5 |
| `boolean` | `Nullable(Bool)` | — |
| `integer` | `Nullable(Int64)` | 精确求和、`Delta` 压缩友好、明细里不会显示成 `3.0` |
| `float` | `Nullable(Float64)` | — |
| `datetime` | `Nullable(DateTime64(3, 'UTC'))` | 与 `_occurred_at` 同精度同时区，时间桶函数可直接用 |

所有业务字段物理上一律允许 `NULL`，包括标记为 `required` 的字段。原因是 `ADD COLUMN` 之后历史行必然没有对应值，如果新增的必填字段是非 Nullable 的，历史行会被读成类型默认值而无法与“真实提交了默认值”区分。是否必填由 Node 按当前 Schema 版本校验。

**`integer` 用 `Int64` 存，但上报值仍受 `±(2^53 - 1)` 约束**（见 8.2）。这不矛盾：上报载荷是 JSON，
而 JSON 数字在 JavaScript 里就是双精度浮点，超过 2^53 的整数**在离开浏览器之前就已经不准了**，
服务端再宽也救不回来。物理列取 `Int64` 是为了求和不溢出（10 亿行 × 百万级数值仍在范围内）。
因此**大整数 ID（雪花 ID、订单号）必须建成 `string`**，这一条要写进管理后台的字段配置提示（见 10.3）。

**为什么 `integer` 不与 `float` 合并成一个 `number`。** 合并就必须选 `Float64`，
于是 `sum(amount)` 在千万行量级会累积浮点误差，金额类统计对不上账；
而且合并之后「给不给等值操作符」变成一个两难：给了，浮点等值就成了陷阱（见 5.4.2）；
不给，`status_code = 500` 这种最常见的过滤就没了。拆成两个类型，这两个问题同时消失。

**为什么 `enum` 的物理类型可以和 `string` 互转。** `LowCardinality(Nullable(String))` 与
`Nullable(String)` 存的是同一批字符串值，差别只在是否字典编码，
所以 `MODIFY COLUMN` 两个方向都无损（见 5.3 / 7.3）。这也是全系统唯一允许的类型转换。

空值语义（六种类型统一）：

- `NULL`：本行没有提交该字段。这是 `is_null` / `is_not_null` 唯一的判据
- 空字符串：`string` 字段明确提交了 `""`。**它不是 `NULL`**，`is_empty` 才是它的判据（见 9.3）；
  `enum` 不可能出现空串，因为选项 `value` 不允许为空（见 5.5）
- `false`：明确提交了布尔假值
- `0`：`integer` / `float` 明确提交了零
- 聚合口径：`sum` / `avg` / `min` / `max` / 分位数**都跳过 `NULL`**，
  因此 `avg` 的分母是「该字段非 `NULL` 的行数」，不是查询命中的总行数。这个口径必须在
  统计结果里明示（见 9.4），否则「平均耗时」会被当成「所有请求的平均耗时」而偏高

V1 不支持：

- 多选枚举（一个字段存多个枚举值）
- 数组
- 嵌套对象
- 文件
- 定点小数 `Decimal`（金额请用 `integer` 存最小货币单位，例如分）
- ClickHouse `Enum8` / `Enum16`（`enum` 走 `LowCardinality(String)`，理由见 5.5）

