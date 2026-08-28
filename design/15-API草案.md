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
```

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
POST   /api/admin/tables/:projectId/fields/:fieldKey/deprecate      # 软废弃
DELETE /api/admin/tables/:projectId/fields/:fieldKey                # 物理删除，高危
GET    /api/admin/tables/:projectId/fields/:fieldKey/usage          # 该字段非空行数，供确认弹窗展示
```

`DELETE .../fields/:fieldKey` 的请求体必须携带 `confirm`，值等于 `fieldKey`。
**没有 `retype` 路由**：字段类型不可修改，操作者需自行「`DELETE .../fields/:fieldKey` →
`POST .../fields`（同名 Key、新类型）」，前端只给提示、不自动串联，见 7.3。

请求体：

| 路由 | 请求体 |
|---|---|
| `POST .../fields` | `{ key, label, type, required, description }`，与 5.2 的字段定义同形，`description` 可省略（默认空串） |
| `PATCH .../fields/:fieldKey` | `{ label?, required?, description? }`，三者至少给一个 |
| `POST .../fields/:fieldKey/rename` | `{ key }`——新 Key |
| `POST .../fields/:fieldKey/deprecate` | 无 |
| `DELETE .../fields/:fieldKey` | `{ confirm }` |
| `GET .../fields/:fieldKey/usage` | 无 |

除 `usage` 外，其余五条成功时返回同一个形状：

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
    "type": "string",
    "required": false,
    "description": "",
    "status": "active",
    "renamedTo": "",
    "schemaVersion": 8,
    "createdAt": "2026-08-27T09:12:00.000Z",
    "updatedAt": "2026-08-27T09:12:00.000Z"
  }
}
```

`table` 是公开视图，永不包含 `physical_name` 与任何密钥字段；`field` 是变更后该 Key 在
`collect_fields` 中的那一行，`renamed_to` 只在 `status = 'renamed'` 时非空。
`rename` 的响应额外带一个 `message`，即 7.3 第 5 步要求的「前端上报代码需同步改用新 Key」提示。
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

### 15.7 系统

```text
GET    /healthz
```

