# 工程约定

本仓库实现 `design/` 目录下的设计稿（V3.1）。**`design/` 是唯一事实来源，实现前必须完整阅读相关章节。**
章节索引与「开发阶段 → 需读章节」对照表见 [`design/README.md`](./design/README.md)；
正文中的交叉引用一律用章节号书写（如「见 7.3」「按 8.3 的表」），按索引定位到对应文件。

## 铁律

1. **不得改动 `design/` 下的任何文件**。发现设计有问题时，写进当前阶段的完成报告，不要自行改设计、不要自行取舍。
2. **不得实现 DESIGN 第 16 节「非目标」中的任何内容**，也不要"顺手"引入 Redis / Kafka / PostgreSQL / MySQL。
   （V3 起 SQLite 是**指定存储**，不再是禁项，见 DESIGN 3.3。）
3. **不得删除或简化已有阶段的代码**来让当前阶段通过。
4. 设计文档里给出的代码片段（`serial.ts`、`limits.ts`、SQL DDL、签名算法、前端上报示例）**逐字实现**，不要"优化"。
5. 所有物理表名、列名只能来自服务端白名单；所有值必须参数化。禁止字符串拼接用户输入进 SQL。
6. 每完成一个阶段，必须保证 `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test` 全绿。

## 技术栈（DESIGN 3）

- 包管理器：pnpm workspace monorepo，`packages/server` + `packages/web`
- 后端：Node LTS + TypeScript(strict) + Fastify + Zod + `@clickhouse/client` + `node:sqlite`
- 前端：Vite + Vue 3 `<script setup>` + TS + Vue Router + Pinia + Element Plus + ECharts
- 测试：vitest
- 存储：SQLite 存管理元数据（账户 / 采集表 / 字段），ClickHouse 存采集数据。持久化根目录 `DATA_DIR`，见 DESIGN 3.3.2
- **标识符：全系统只有一个公开 ID `projectId`（`prj_` 前缀，ULID）**，既是路由标识也是上报签名主体。
  不存在 `tableId`。物理表名 `physical_name` 是内部实现细节，永不出现在任何 API 响应里。

## ClickHouse 三账户（DESIGN 3.4）

`ch_ingest` / `ch_meta` / `ch_readonly` 三个独立 client 实例，权限互不重叠。V3 起 ClickHouse 侧只有 `data` 库。
**`async_insert` 只能作为上报路径的 query-level setting 传入，绝不能配在 client 的默认 settings 或全局配置上。**

## SQLite（DESIGN 3.3.2、6.2–6.4）

- 使用 Node 内置 `node:sqlite`，**不要引入 better-sqlite3 之类的原生依赖**。
- 库文件路径固定为 `$DATA_DIR/sqlite3/app.db`，启动时自动建目录。
- DESIGN 3.3.2 列出的四条 PRAGMA 必须全部启用。
- 全部使用预编译语句绑定参数，禁止拼接。
- **唯一性靠数据库约束，不靠先查后写。** 捕获约束冲突并翻译成 `USERNAME_EXISTS` / `FIELD_KEY_RETIRED`。

## 并发模型（DESIGN 3.3.3）

- 上报路径不加任何锁。
- 纯 SQLite 的元数据读-改-写包在 `BEGIN IMMEDIATE` 事务内。
- **跨存储操作（建表、加字段、改名、删字段）必须经过 `serial()` 串行队列**——
  它们同时动 ClickHouse DDL 和 SQLite 元数据，无法放进同一个事务。

## `FINAL` 的正确性（DESIGN 6.5、9.1）

业务数据表查询**一律不加 `FINAL`**。V3 起元数据在 SQLite，`FINAL` 与 `PREWHERE` 的注意事项不再适用。

## 错误处理

全站统一错误响应体与错误码 → HTTP 映射，严格按 DESIGN 8.3 的表实现，不得新增或改名错误码。
字段类错误必须回传 `error.expected`（取自 `meta.collect_fields` 的 active 行）。

## 本地开发环境

ClickHouse 跑在 docker 容器 `log-ch`：`http://localhost:8123`，管理员账号 `default` / `devpass`。
本地 `DATA_DIR` 默认指向仓库外的临时目录；测试用独立的 SQLite 文件，不要污染开发库。
`packages/server/.env.example` 必须覆盖 DESIGN 附录 B 的全部环境变量。

## 完成报告

每个阶段结束时，在最后一条消息里输出：
1. 新增/修改的文件清单
2. 已实现的 DESIGN 章节编号
3. 明确未实现或有偏差的地方 + 原因
4. 你跑过的验证命令及其结果（贴真实输出，不要编造）

## 对 DESIGN 的授权补充（已经用户确认，视同设计的一部分）

这些是 `design/` 未覆盖的空白，由项目负责人拍板补充。**后续阶段必须遵守，不要因为「文档里没有」而回退掉。**

1. **`ROUTE_NOT_FOUND`（HTTP 404）**：DESIGN 8.3 的错误码表只有资源级 404，没有「路由不存在」。
   新增此错误码，并用 `setNotFoundHandler` 让未匹配路由也返回统一错误响应体，保证「全站统一错误响应体」成立。
2. **健康检查探测超时 3 秒**：`pingClickHouse()` 必须带独立的 3 秒超时，超时即判 `degraded` + HTTP 503。
   避免 ClickHouse 卡死（连接不 RST）时 `/healthz` 挂满 CH client 的默认 `request_timeout`。
3. **`UNSUPPORTED_MEDIA_TYPE`（HTTP 415）**：DESIGN 8.3 的错误码表没有 415，而 Fastify 内建的
   `FST_ERR_CTP_INVALID_MEDIA_TYPE` 是 415。新增此错误码，让不支持的 `content-type` 保持 415
   并落在统一错误响应体里，而不是被兜底分支降级成 500。
4. **`limits.auth.captchaRateLimitPerIp`（默认 60，每分钟）**：DESIGN 附录 A 只给了登录限流。
   `/api/auth/captcha` 是匿名接口，不限流就能被无成本刷爆进程内 Map，因此在附录 A 的基础上
   补充这一项（环境变量 `LIMIT_AUTH_CAPTCHA_RATE_LIMIT_PER_IP`）。

5. **`INVALID_TABLE_ID` → `INVALID_PROJECT_ID`（HTTP 400，改名）**：V3.1 起系统只有一个公开 ID
   `projectId`（见 DESIGN 6.3）。该错误码是**面向业务方可见**的，名字里带 `TABLE_ID`
   会把已经砍掉的概念重新暴露出去，因此随之改名。**只改这一个**——
   `TABLE_NOT_FOUND` / `TABLE_DISABLED` / `TABLE_NOT_READY` / `TABLE_STATE_CONFLICT`
   指的是「采集表」这个资源而不是 ID，保持原名不动。

**以上列出的之外，仍然不得新增或改名任何错误码。**

## 方案确认
当方案不可避免的需要使用非稳定方案时，必须告诉用户。比如用户让完成程序：“如果辱骂他人，就禁言”，实现用正则匹配。