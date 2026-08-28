# TODO — 设计实现进度

对照 [`design/`](./design/)（**V3.1 设计稿**）与当前代码逐节盘点。
`design/` 是唯一事实来源，本文件只记录进度。

> **进度**：阶段 A、B、C、D 全部完成并验收通过（A-0 SQLite 迁移 / A-1 表级管理 / A-2 字段变更 /
> B-1 启动期 reconcile / B-2 删表与建表模板 / C 上报接口 / D 查询、统计与导出），
> 并完成 V3.1 标识符收敛（砍掉 `tableId`，全系统只有一个公开 ID `projectId`）。
> 元数据在 SQLite、采集数据在 ClickHouse，持久化收敛到单一 `DATA_DIR`（3.3）。
> **服务端 API 全部完工，当前在做阶段 E（管理后台前端）。**
>
> **当前基线**（验收对比用）：32 条路由、39 个错误码；`pnpm -r typecheck / lint / test` 全绿——
> 服务端 30 files / 178 tests，web 5 files / 41 tests；`prettier --check` 与 web `build` 通过。
>
> 2026-08-28 废弃 `POST .../fields/:fieldKey/retype` 后路由 33→32、服务端 tests 179→178。
>
> 已完成事项与各阶段验收过程记录已于 2026-08-28 清理；**仍然生效的拍板规则保留在第二节**。
> 设计稿同日按章节从单文件 `DESIGN.md` 拆分到 `design/`，内容逐字未改，章节号不变。

---

## 一、未完成

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

剩余子阶段：E-3 表详情·字段配置·高危两级确认·密钥·接入文档／
E-4 数据概览·明细查询·统计分析／E-5 账户管理。

**B-2 的服务端接口已就绪，对应的前端交互全部落在本阶段**（见下面最后三条）。

- [ ] 数据概览（今日总量按用户时区、最近 24 小时趋势、各表上报量、最近上报时间；**不做失败数量卡片**）
- [ ] 字段配置与 Schema 版本页
      （**2026-08-28 项目负责人定的交互**：重命名只改 Key、老数据直接复用、旧 Key 的上报即刻失效；
      **字段类型不可修改**——不提供「改类型」入口，类型旁固定展示一句提示
      「不能修改字段类型，请先删除该列，再新建同名列」，操作者自行走「物理删除」+「新增字段」
      两个独立操作，**前端不做两步之间的自动串联**。
      **retype 的去留已于 2026-08-28 拍板：废弃。** 设计 01 / 03 / 05 / 07 / 10 / 11 / 15 / 17
      已同步改定，服务端 `retype` 路由与 `retypeField` 已删除并验收通过。
      注意 10.4 第 5 条的成功提示也跟着改了——**不要再提示「该 Key 已永久退役」**，
      按 5.2 `dropped` 的 Key 可以重建，只是建出的是一列全新的空列）
- [ ] 上报接入文档页（密钥展示 + 可一键复制的 TypeScript 示例，逐字取自 DESIGN 8.1.3）
- [ ] 数据明细查询（条件构造器 + 游标分页）
- [ ] 统计分析（ECharts 图表）
- [ ] 账户管理
- [ ] 高危操作两级确认（10.4）：危险色按钮收进「更多」菜单 → 一级弹窗展示 key/label/type + 实时非空行数 → 二级要求手输字段 Key → 请求带 `confirm` → 成功提示「该列历史数据已永久删除、不可恢复」
      （**不要说「Key 已永久退役」**，按 5.2 该 Key 可以重建，见 10.4 第 5 条）
- [ ] 字段重命名一级确认 + 「前端上报代码需同步改 Key」提示
- [ ] **删除数据采集表的两级确认（10.4 额外四条）**：入口只在详情页、只对 `super_admin` 渲染，
      状态不是 `archived` / `failed` 时置灰并提示「请先归档」；一级弹窗实时展示 `displayName` /
      `projectId` / 字段数 / **该表总行数**（`SELECT count()`）/ 创建时间与创建人，并写明三条后果；
      二级要求手输 **`displayName`**（不是 `projectId`）；成功后跳回列表页提示「已永久删除，无法恢复」。
      一级弹窗要的「总行数」由阶段 D 新增的 `GET /api/admin/tables/:projectId/row-count` 提供
      （权限 `admin` 起，`archived` 状态下同样可用），字段级仍用 `.../fields/:fieldKey/usage`。

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
      两个子目录（DESIGN 3.3.2），建不出来直接停止启动，不进 Node。
      这是 A-0 那条「`sqliteDatabase` 模块级单例在 import 时 mkdir」的最终处置
      （2026-08-28 拍板：**不改 Node 代码形态**，单例保留，目录由启动脚本负责）。
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

### 来自阶段 A-0（SQLite 迁移）验收

- [ ] **`sqliteDatabase` 模块级单例仍在 import 时 mkdir 并打开库文件**（`src/infra/sqlite.ts:132`
      的 `export const sqliteDatabase = openSqliteDatabase(env.DATA_DIR)`，`mkdirSync` 在 `:57`）。
      `DATA_DIR` 不可写时进程会在模块加载阶段抛错，此时 logger 还没建好，报错不走结构化日志。
      ~~阶段 B 接启动流程时处理。~~ ~~改到阶段 C 一并处理。~~
      **阶段 C 也没做，是我在派工时明确写进禁止项的**（2026-08-27 验收记）。理由：
      ① `server.ts` 已有 `assertSqliteDirectoryWritable()` 在动态 import 之前跑，
      `DATA_DIR` 不可写时会打印明确的 stderr 原因并 `exit(1)`，**这个失败模式实际已被覆盖**，
      剩下的只是「报错格式不是结构化 JSON」；
      ② 改成惰性单例要动 `repository.ts` / `reconcile.ts` / `schema.ts` 等全部 import 点，
      与 ingest 毫无关系，风险远大于收益。
      ~~**结论：降级为「非缺陷的形态问题」，挪到阶段 G**。~~
      **2026-08-28 项目负责人拍板：不改代码形态。**改由 Dockerfile 的初始化 / 启动命令
      先 `mkdir -p $DATA_DIR/sqlite3 $DATA_DIR/clickhouse`（DESIGN 3.3.2 的两个子目录），
      建不出来就直接停止启动、不进 Node。`sqliteDatabase` 保持模块级单例。
      **落地在阶段 G**，见下面 G 的待办。

### 来自阶段 A-2（字段变更）验收

- [ ] **五条补充规则待你确认。** DESIGN 没覆盖，由我拍板后交给 codex 实现，均已端到端验证生效：
  1. 可操作字段 = `status = 'active'` 的行；对 `deprecated` / `dropped` / `renamed` 或
     完全不存在的 Key 做变更一律 `FIELD_NOT_FOUND`(404)。
  2. 字段变更要求物理表存在 → 只允许表状态 `active` / `disabled`；
     `creating` / `failed` / `archived` 返回 `TABLE_STATE_CONFLICT`(409)。
     （不复用 `TABLE_NOT_READY` / `TABLE_DISABLED`，那是上报路径 DESIGN 8.2 的语义。）
  3. `FIELD_KEY_EXISTS`(409) = Key 正被一行 `active` 占用；`FIELD_KEY_RETIRED`(409) = Key 是
     `deprecated`。`dropped` / `renamed` 自 2026-08-28 起可复用，不再产生冲突（见 DESIGN 5.2）。
  4. 15.4 的 7 条路由全部 `admin` 起，含 `usage`（它服务于高危二次确认弹窗）。
  5. 软废弃使 `schema_version` 加一（依据 DESIGN 5.3 开头那句，表格里该行未写「版本不变」）。

### 来自阶段 C（上报接口）验收

**派工时我替 DESIGN 拍板补充的规则**（均已落地并有测试，已拍板存档）：

1. **校验顺序**：DESIGN 8.1.2 与 8.2 的步骤顺序有出入（8.2 把「读表定义」排在验签之后，
   但验签必须先拿到该表的密钥）。最终落地顺序：Origin → 限流 → `projectId` 格式 → envelope 解析 →
   `p` 与 URL 比对 → 读表定义 → 时间窗 → nonce → **验签** → 表状态 → `d` 大小 → payload 解析 →
   `recordId` → `occurredAt` → 字段数 → 字段白名单。
   即**表状态在验签之后**（不给未验签者探测表状态），**nonce 在验签之前**（照 DESIGN 8.1.2 原文）。
2. **表状态 `failed` → `TABLE_NOT_READY`(503)**。DESIGN 8.2 第 4 步只写了 `disabled` / `archived` /
   `creating`，没提 `failed`；`failed` 表的物理表可能压根不存在，语义上就是「还没就绪」。
3. **nonce 的 key 是 `${projectId}:${nonce}`**。DESIGN 只说「`n` 在进程内 LRU 中未出现过」，
   没定义作用域；按项目隔离，避免 A 项目的 nonce 误杀 B 项目。
4. **`dropped` / `renamed` 的 Key 按 `UNKNOWN_FIELD` 处理，只有 `deprecated` 才是 `DEPRECATED_FIELD`**
   （物理列已经不存在了，与「不认识」等价）。与 A-2 补充规则 1 的风格一致。
   为区分二者，**只在已经发现未知 Key 的错误路径上**多查一次 SQLite，成功路径不受影响。
5. **值为 `null` / `undefined` 视为「未提交该字段」**（写 `NULL`；该字段若 `required` 则报
   `REQUIRED_FIELD_MISSING`）。空字符串仍是「明确提交了空串」，符合 DESIGN 6.6 的空值语义。
6. **字符串长度按 UTF-8 字节数**算（不是 UTF-16 码元）。
7. **同一 payload 里多种字段错误并存时，先报第一个未知 Key**（按 `Object.keys` 的插入顺序），
   顺序已被测试锁住。
8. **不带 `Origin` 头的请求放行**（非浏览器客户端可任意伪造，DESIGN 12.1 明说它不是依赖项）；
   白名单含 `*` 时全放行，此时 `/api/ingest/` 的 CORS 响应头也发 `*`（`app.ts` 的 `corsDelegate`
   为此加了一个分支，控制台路径行为不变）。

- [ ] **未验签的请求也会占用 nonce 空间。** 这是 DESIGN 8.1.2 自己的顺序（第 3 步 nonce、
      第 4 步验签）导致的：攻击者可以用任意 nonce 刷 LRU。唯一屏障是前置的令牌桶限流
      （IP 100/秒）。V1 可接受，记录备查。

### 来自阶段 E-2（表列表与建表）验收

- [ ] **建表路径的 ClickHouse 故障映射成 `INTERNAL_ERROR`，不是 `CLICKHOUSE_UNAVAILABLE`(503)。**
      阶段 D 拍板的 `classifyClickHouseError()` 只接在查询与上报路径上，建表 / DDL 路径没接。
      2026-08-28 验收时停掉 `log-ch` 实测：表正确落 `failed`、前端列表刷新出「失败」行、
      提示是「服务暂时不可用，请稍后重试」（`INTERNAL_ERROR` 的中文映射）。
      行为正确、无数据不一致，只是错误码语义不如 503 精确。要统一得改服务端
      `domain/tables/repository.ts` 的建表分支，**留待阶段 F 或 G 决定，不在 E 阶段动**。
- [ ] **模板回填与字段列表的顺序是 `ORDER BY field_key`**（`domain/tables/repository.ts:682`），
      不是源表定义字段时的顺序。E-3 的字段配置页会看到同样的顺序。
      V1 没有「字段排序」概念（DESIGN 5.2 未定义），记录备查。

### 来自阶段 D（查询、统计与导出）验收

**派工时我替 DESIGN 拍板补充的规则**（均已落地并有测试，已拍板存档）：

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
9. **过滤字段白名单只认当前 active 字段**，`_` 开头的系统列一律拒绝（时间范围已单独处理），
   已废弃 / 已删除 / 已改名的字段等同未知字段 → `INVALID_QUERY`。
10. **`in` / `not_in` 的数组元素数计入 `maxConditions`**（32），避免用一个条件塞进上万个值。

- [ ] **CSV 导出走 `reply.hijack()`，因此 `app.ts` 的 `onResponse` 四要素日志（DESIGN 12.4 的
      `route` / `statusCode` / `durationMs`）对 export 请求不会输出。**
      目前由 `logSuccess` 补了 `requestId` / `projectId` / `operation` / `schemaVersion` / `rowCount`，
      但缺 `statusCode` 与 `durationMs`。要补的话需要在 hijack 前后自己计时并补一条日志。
- [ ] **CSV 里的 `_occurred_at` / `_received_at` 是 ClickHouse 原始格式**
      （`2026-08-27 08:11:03.219`），而明细 JSON 走 `clickHouseDateTimeToIso()` 转成了 ISO-8601。
      两者不一致。CSV 是给 Excel / 人看的，原始格式反而更友好，暂不统一，但阶段 E 做导出按钮时要知道。
- [ ] **上报路径新增的 `CLICKHOUSE_UNAVAILABLE` 分支没有端到端测试。**
      `classifyClickHouseError()` 本身在 `query.test.ts` 有单测（连接错误 / abort / 嵌套 cause /
      限额 / 服务端错误五类都覆盖了），`ingest/routes.ts` 里的接线只有 3 行，
      风险很低，但严格说没测到。留给阶段 F。
- [ ] **导出的截断行数在极端情况下会略偏**：`total` 来自导出前的一次 `count()`，
      如果两次查询之间又写入了新行，末行注释里的 `of <total>` 会略小于真实值。可忽略。

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
