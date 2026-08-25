# 工程约定

本仓库实现 `DESIGN.md`（V2 设计稿）。**`DESIGN.md` 是唯一事实来源，实现前必须完整阅读相关章节。**

## 铁律

1. **不得改动 `DESIGN.md`**。发现设计有问题时，写进当前阶段的完成报告，不要自行改设计、不要自行取舍。
2. **不得实现 DESIGN 第 16 节「非目标」中的任何内容**，也不要"顺手"引入 Redis / Kafka / PostgreSQL / MySQL / SQLite。
3. **不得删除或简化已有阶段的代码**来让当前阶段通过。
4. 设计文档里给出的代码片段（`serial.ts`、`limits.ts`、SQL DDL、签名算法、前端上报示例）**逐字实现**，不要"优化"。
5. 所有物理表名、列名只能来自服务端白名单；所有值必须参数化。禁止字符串拼接用户输入进 SQL。
6. 每完成一个阶段，必须保证 `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test` 全绿。

## 技术栈（DESIGN 3）

- 包管理器：pnpm workspace monorepo，`packages/server` + `packages/web`
- 后端：Node LTS + TypeScript(strict) + Fastify + Zod + `@clickhouse/client`
- 前端：Vite + Vue 3 `<script setup>` + TS + Vue Router + Pinia + Element Plus + ECharts
- 测试：vitest
- 存储：只有 ClickHouse

## ClickHouse 三账户（DESIGN 3.4）

`ch_ingest` / `ch_meta` / `ch_readonly` 三个独立 client 实例，权限互不重叠。
**`async_insert` 只能作为上报路径的 query-level setting 传入，绝不能配在 client 的默认 settings 或全局配置上。**

## 并发模型（DESIGN 3.3.1）

- 上报路径不加任何锁。
- **所有元数据写入（建表、DDL、改状态、账户增删改）必须经过 `serial()` 串行队列**，`version` 的读取与写回必须在同一个 `serial()` 临界区内完成。

## `FINAL` 的正确性（DESIGN 6.2）

读元数据一律 `FINAL`；必须显式固定 `optimize_move_to_prewhere_if_final = 0`；**禁止把 `status` 等版本相关列写进 `PREWHERE`**。
业务数据表查询**一律不加 `FINAL`**。

## 错误处理

全站统一错误响应体与错误码 → HTTP 映射，严格按 DESIGN 8.3 的表实现，不得新增或改名错误码。
字段类错误必须回传 `error.expected`（取自 `meta.collect_fields` 的 active 行）。

## 本地开发环境

ClickHouse 跑在 docker 容器 `log-ch`：`http://localhost:8123`，管理员账号 `default` / `devpass`。
`packages/server/.env.example` 必须覆盖 DESIGN 附录 B 的全部环境变量。

## 完成报告

每个阶段结束时，在最后一条消息里输出：
1. 新增/修改的文件清单
2. 已实现的 DESIGN 章节编号
3. 明确未实现或有偏差的地方 + 原因
4. 你跑过的验证命令及其结果（贴真实输出，不要编造）

## 对 DESIGN 的授权补充（已经用户确认，视同设计的一部分）

这些是 `DESIGN.md` 未覆盖的空白，由项目负责人拍板补充。**后续阶段必须遵守，不要因为「文档里没有」而回退掉。**

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

**以上列出的之外，仍然不得新增或改名任何错误码。**
