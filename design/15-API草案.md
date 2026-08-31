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

账户接口以 `username` 寻址，与 `app_users` 的 `UNIQUE` 列保持一致，避免每次操作都要反查。

### 15.3 数据采集表

```text
GET    /api/admin/tables
POST   /api/admin/tables
GET    /api/admin/tables/templates                   # 建表模板下拉，见 10.5
GET    /api/admin/tables/:projectId
GET    /api/admin/tables/:projectId/template         # 建表模板回填内容，见 10.5
DELETE /api/admin/tables/:projectId                  # 物理删除，仅 super_admin，见 7.5
POST   /api/admin/tables/:projectId/retry            # failed → creating，幂等重试
POST   /api/admin/tables/:projectId/status           # 状态迁移，见 5.1
GET    /api/admin/tables/:projectId/secret           # 查看当前上报密钥
POST   /api/admin/tables/:projectId/secret/rotate    # 轮换密钥
GET    /api/admin/tables/:projectId/row-count        # 该表当前总行数，供删表确认弹窗展示
```

`GET /api/admin/tables/:projectId` 的响应形如 `{ table, fields }`：`table` 是 15.4 那个公开视图，
`fields` 是该表在 `collect_fields` 中的**全部行**（按 `field_key` 排序），每行与 15.4 的 `field` 同形，
**含 `deprecated` / `dropped` / `renamed` 墓碑**。10.3 要求字段列表能看到软废弃字段，
5.2 的墓碑 Key 也必须让操作者看得见，否则一个字段被废弃之后就直接从界面上消失了。
这与 9.1 的查询白名单是两回事：那里默认只给 `active`，这里是管理视图，要给全貌。

`GET .../row-count` 返回 `{ "count": 1234567 }`，用 `ch_readonly` 账户执行 `SELECT count()`，
是 10.4 删表弹窗第 2 条要求的「该表当前的总行数」。与 `.../fields/:fieldKey/usage` 同类，
只是粒度从一列扩到整张表。权限与其他管理接口一致（`admin`、`super_admin`）。

`DELETE /api/admin/tables/:projectId` 的请求体必须携带 `confirm`，值等于该表的 `displayName`。
删除成功返回 `{ "projectId": "prj_01K...", "deleted": true }`——元数据与物理表都已不存在，
没有可回传的表对象，只回执被删除的 ID。

`/tables/templates` 与 `/tables/:projectId` 不冲突：Fastify 的 find-my-way 让静态段优先于参数段，
与注册顺序无关（已实测）。此外 `parseProjectId` 会用 `projectIdPattern` 校验，`templates` 本来也过不了。

### 15.4 字段

```text
POST   /api/admin/tables/:projectId/fields                          # 新增
PATCH  /api/admin/tables/:projectId/fields/:fieldKey                # 改 label / description / required
POST   /api/admin/tables/:projectId/fields/:fieldKey/rename         # 改 key，数据保留
PUT    /api/admin/tables/:projectId/fields/:fieldKey/options        # 全量提交枚举选项，见 7.3
POST   /api/admin/tables/:projectId/fields/:fieldKey/retype         # 仅 string ⇄ enum，数据保留
POST   /api/admin/tables/:projectId/fields/:fieldKey/deprecate      # 软废弃
DELETE /api/admin/tables/:projectId/fields/:fieldKey                # 物理删除，高危
GET    /api/admin/tables/:projectId/fields/:fieldKey/usage          # 该字段非空行数，供确认弹窗展示
```

`DELETE .../fields/:fieldKey` 的请求体必须携带 `confirm`，值等于 `fieldKey`；
它接受 `active` 与 `deprecated` 两种状态的字段，`dropped` / `renamed` 返回 `FIELD_NOT_FOUND`（见 7.3）。
`PATCH` / `rename` / `options` / `retype` / `deprecate` 五条则**只接受 `active`**，
对 `deprecated` 字段一律 `FIELD_NOT_FOUND`。

**`retype` 只接受 `string → enum` 与 `enum → string` 两个方向**，其余组合返回
`INVALID_FIELD_TYPE`（400）。这是全系统唯一的类型变更接口，因为只有这一对转换是无损的（见 5.3 / 7.3）；
换成其它类型仍然要操作者自行「`DELETE .../fields/:fieldKey` → `POST .../fields`（同名 Key、新类型）」，
前端只给提示、不自动串联。

请求体：

| 路由 | 请求体 |
|---|---|
| `POST .../fields` | `{ key, label, type, required, description, options? }`，与 5.2 的字段定义同形，`description` 可省略（默认空串）；`options` 仅 `enum` 允许且必须非空 |
| `PATCH .../fields/:fieldKey` | `{ label?, required?, description? }`，三者至少给一个 |
| `POST .../fields/:fieldKey/rename` | `{ key }`——新 Key |
| `PUT .../fields/:fieldKey/options` | `{ options: [{ value, label, status? }] }`，**全量**，数组顺序即展示顺序，`status` 默认 `active` |
| `POST .../fields/:fieldKey/retype` | `{ type: 'enum', options: [...] }` 或 `{ type: 'string' }` |
| `POST .../fields/:fieldKey/deprecate` | 无 |
| `DELETE .../fields/:fieldKey` | `{ confirm }` |
| `GET .../fields/:fieldKey/usage` | 无 |

`PUT .../options` 的三条规则见 7.3，其中最关键的一条：**现存 `value` 必须全部出现在提交列表里**，
少任何一个返回 `INVALID_FIELD_VALUE`（400）——选项只能停用不能删除，
「没提交就自动停用」会让一次少传静默关掉线上还在用的选项。

除 `usage` 外，其余七条成功时返回同一个形状：

```json
{
  "table": {
    "projectId": "prj_01K...",
    "displayName": "登录日志",
    "description": "",
    "status": "active",
    "schemaVersion": 8,
    "createdBy": "alice",
    "createdAt": "2026-08-27T08:00:00.000Z",
    "updatedAt": "2026-08-27T09:12:00.000Z"
  },
  "field": {
    "key": "country_code",
    "label": "国家代码",
    "type": "enum",
    "required": false,
    "description": "",
    "status": "active",
    "renamedTo": "",
    "schemaVersion": 8,
    "options": [
      { "value": "cn", "label": "中国", "status": "active" },
      { "value": "sg", "label": "新加坡", "status": "disabled" }
    ],
    "createdAt": "2026-08-27T09:12:00.000Z",
    "updatedAt": "2026-08-27T09:12:00.000Z"
  }
}
```

`table` 是公开视图，永不包含 `physical_name` 与任何密钥字段；`field` 是变更后该 Key 在
`collect_fields` 中的那一行，`renamed_to` 只在 `status = 'renamed'` 时非空。
`options` 按 `sort_order` 排序，**含已停用的选项**（历史数据里还有它们，图例要按 `label` 渲染，见 5.5）；
非 `enum` 字段该数组恒为 `[]`。
`rename` 的响应额外带一个 `message`，即 7.3 第 5 步要求的「前端上报代码需同步改用新 Key」提示；
`retype` 的响应同样带 `message`，内容见 7.3 第 5 步。
`usage` 返回 `{ "count": 12345 }`，是该字段当前的非空行数（见 10.4 的确认弹窗）。

### 15.5 上传

```text
POST   /api/ingest/v1/projects/:projectId/rows
```

### 15.6 查询和统计

```text
POST   /api/admin/tables/:projectId/query        # 明细，游标分页
POST   /api/admin/tables/:projectId/statistics   # 趋势 / 分组 / 去重计数，必带 tz
POST   /api/admin/tables/:projectId/export       # CSV 流式导出
```

请求体：

| 路由 | 请求体 |
|---|---|
| `POST .../query` | `{ range, filter?, includeFields?, limit?, order?, cursor? }` |
| `POST .../statistics` | `{ range, tz, dimension?, measure, filter? }` |
| `POST .../export` | `{ range, filter?, includeFields?, order? }` |

`includeFields` 是可选的字符串数组，默认 `[]`，用于显式选择已废弃字段，规则见 9.1；
`statistics` 没有这个参数——它的 `dimension.field` / `measure.field` / `axis` 本来就是
显式写出来的字段名，直接放行 `deprecated`。
`range` 是 `{ start, end }` 毫秒时间戳，`filter` 是 9.3 的条件树，`cursor` 是 9.1 的不透明游标。

`statistics` 的两个轴：

```json
{
  "dimension": { "kind": "time", "axis": "_occurred_at", "granularity": "day" },
  "measure": { "fn": "sum", "field": "pay_amount" }
}
```

- `dimension` 可省略（不分组，返回单值），或取 `kind: "time"`（`axis`、`granularity`）
  / `kind: "field"`（`field`、可选 `limit`）。
- `measure.fn` 取 `count` / `unique` / `sum` / `avg` / `min` / `max` / `p50` / `p90` / `p99`，
  除 `count` 外都必须带 `field`。
- 字段能否出现在某个位置由 5.4.2 的能力矩阵决定，不匹配返回 `INVALID_QUERY`。
- 完整语义、生成的 SQL 与响应形状见 9.4。

### 15.7 系统

```text
GET    /healthz
```

### 15.8 字段类型能力矩阵

```text
GET    /api/admin/field-types
```

把 5.4.2 的矩阵原样下发给管理后台，**与任何一张采集表无关**，是全系统的静态元数据：

```json
{
  "types": [
    {
      "type": "float",
      "label": "小数",
      "capabilities": ["ordered", "summable"],
      "operators": ["gt", "gte", "lt", "lte", "is_null", "is_not_null"],
      "measures": ["min", "max", "sum", "avg", "p50", "p90", "p99"]
    }
  ],
  "operators": [
    { "op": "gt", "label": "大于", "arity": "one" },
    { "op": "in", "label": "属于", "arity": "many" },
    { "op": "is_null", "label": "未提交", "arity": "none" }
  ],
  "measures": [{ "fn": "p90", "label": "P90" }]
}
```

`capabilities` 是原始能力，`operators` / `measures` 是服务端**已经替前端推导好**的结果——
前端不需要知道「`ordered` 能派生出哪四个操作符」这条规则，照着列表渲染下拉即可。
两者都给，是因为前端偶尔要按能力做整块的显示判断（例如「这个字段能不能当分组维度」
直接看有没有 `groupable`，而不是去 `measures` 里反查）。

权限与其它管理接口一致，登录即可读。内容在进程生命周期内不变，前端启动时拉一次即可，
响应可以带较长的 `Cache-Control`。

**这条接口存在的唯一理由是消灭前后端的两份真值。** 没有它，前端就必须在 TypeScript 里
再写一遍「哪个类型能用哪些操作符」，而这份副本一旦和服务端的校验逻辑漂移，
表现是用户在界面上选了一个操作符、点查询、收到 `INVALID_QUERY`——
一类只能靠用户报障才能发现的 bug。

