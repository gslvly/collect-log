# 工程约定

本仓库实现 `design/` 目录下的设计稿（V4.0）。**`design/` 是唯一事实来源，实现前必须完整阅读相关章节。**
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
7. **`packages/*/src` 下单个源码文件不得超过 500 行**（`.ts` / `.vue` / 测试文件一视同仁）。
   写着写着超了就当场切分，不要留到「以后再说」。
   切分按职责切，**不是机械按行数腰斩**：Vue 页面拆出子组件与纯逻辑模块（沿用现有
   `XxxView/` 一页一文件夹、`.vue` + `xxx.logic.ts` + 单测的结构），服务端按领域概念拆模块，
   测试按被测行为分文件。切分是纯重构——**对外行为、公开接口、用例总数都不许变**。

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

**开发阶段不启动 docker，程序与 ClickHouse 都直接跑在本机。** 本机已装 ClickHouse，监听
`http://localhost:8123`，连接参数见 `packages/server/.env`。**不要执行 `colima start` /
`docker start log-ch`**，容器化留到阶段 G 再做。启动命令：

```bash
nohup /opt/homebrew/bin/clickhouse server --config-file="$PWD/data/ch-config/config.xml" >/dev/null 2>&1 &
```

本地 `DATA_DIR` 是**仓库根目录下的 `data/`**（`data/sqlite3/` + `data/clickhouse/` + `data/ch-config/`，
已在 `.gitignore` 里忽略）；测试自己在系统临时目录下开独立的 `DATA_DIR` 与 SQLite 文件，不会污染开发库。
`packages/server/.env.example` 必须覆盖 DESIGN 附录 B 的全部环境变量。

因此**每个阶段结束时 `pnpm -r typecheck` / `pnpm -r lint` / `pnpm -r test` 必须全绿**（铁律 6），
包括依赖 ClickHouse 的集成测试。跑不通要先排查本机 ClickHouse 是否在跑，
**不得靠改测试、跳过用例或删代码来变绿**。注意本机 shell 里设了 `http_proxy=http://127.0.0.1:7890`，
用 `curl` 手工探 ClickHouse 时要加 `--noproxy '*'`，Node 侧不受影响。

## 完成报告

每个阶段结束时，在最后一条消息里输出：
1. 新增/修改的文件清单
2. 已实现的 DESIGN 章节编号
3. 明确未实现或有偏差的地方 + 原因
4. 你跑过的验证命令及其结果（贴真实输出，不要编造）

## 对 DESIGN 的授权补充（已经用户确认，视同设计的一部分）

这里记项目负责人已经拍板、但 `design/` 还没收录的补充。**后续阶段必须遵守，不要因为「文档里没有」而回退掉。**

原先积压的五条已于 2026-08-29 随 V3.2 全部回写进 `design/` 正文：
`ROUTE_NOT_FOUND` 与 `UNSUPPORTED_MEDIA_TYPE` → 8.3 的错误码表；`/healthz` 的 3 秒探测超时 → 12.5；
`limits.auth.captchaRateLimitPerIp` → 附录 A；`INVALID_TABLE_ID` → `INVALID_PROJECT_ID` 的改名
在 V3.1 时就已写进 01。

### 1. 前端不再提供时区选择（2026-08-29 拍板）

9.2 要求按时间粒度聚合的接口必须带 IANA 时区，这条不变，**变的是这个值从哪来**：
一律取 `Intl.DateTimeFormat().resolvedOptions().timeZone`（非法时回落 `'UTC'`），
**用户不可选、不可改、不落 localStorage**，界面上也不再出现时区名。
`stores/timezone.ts` 因此只保留只读的 `timeZone` 与 `formatUtc`。

### 2. CSV 导出改为 File System Access API 流式落盘（2026-08-29 拍板）

9.5 的流式导出，前端一侧**不得用 `response.blob()` 整包缓冲**——`export.maxRows` 是 100 万行，
缓进内存会把标签页打爆。实现固定为 `showSaveFilePicker()` → `fetch()` → `createWritable()` →
`response.body.pipeTo(writable)`，且 `showSaveFilePicker()` **必须在 `fetch()` 之前**调用
（Chrome 瞬时用户激活只有 5 秒，而导出最长跑 120 秒）。

**只支持 Chrome / Edge**，且需要安全上下文（HTTPS 或 localhost）。
不满足时给明确提示，**不得退回 blob 方案兜底**。

### 3 与 4（`number` 字段类型及其操作符）已于 2026-08-30 随 V4.0 作废

这两条描述的过渡态类型 `number` 已被 V4.0 的六类型体系取代（`integer` / `float` 拆开，
见 5.4、6.6）。**现在一律以 `design/` 正文为准，不要再按这两条实现**：

- 类型白名单是六种，不再有 `number`；物理映射按 6.6 的表。
- 值域校验拆成「形状」与「取值」两步，后者用新错误码 `INVALID_FIELD_VALUE`（8.2.1、8.3）——
  这是 V4.0 唯一新增的错误码，已写进 8.3 的表，属于「按设计实现」而非「自行新增」。
- 数值聚合不再是非目标，`sum` / `avg` / `min` / `max` / 分位数按 9.4 的两轴模型实现。
- **原第 4 条记的「`filter.ts` 对 `lt` / `lte` 误包 NULL」这个已知偏差，就在 V4 这一批修**
  （见 todo.md 的 V4-4）。固化了错误行为的那两处测试断言要一并改掉。

新的拍板先记到这里，攒够一批再一次性回写设计——每改一句就动一次唯一事实来源，
既容易和正在进行的实现打架，也会让版本记录碎成一地。

**这一节列出的之外，仍然不得新增或改名任何错误码。**

## 开发
所有 dialog组件 例如：editTask 使用 `<v-dialog >xxx</v-dialog>` ，在外层使用v-if控制是否显示<editTask v-if="visible">