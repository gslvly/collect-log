# collect-log

前端主动上报的动态数据采集系统 —— 设计文档。

管理员在后台创建「数据采集表」并配置字段，系统生成公开 `projectId` 与上报密钥；业务前端按签名协议主动调用上传接口，一次上报在 ClickHouse 中写入一行；后台按时间与业务字段做筛选、分组与统计。

不是自动采集行为的埋点 SDK，也不是可反复编辑的表单系统。

## 技术栈

- 前端：Vite + Vue 3 + TypeScript + Element Plus + ECharts
- 后端：Node.js LTS + TypeScript + Fastify
- 存储：SQLite（账户与管理元数据）+ ClickHouse（采集数据）

## 文档

完整设计见 [design/](./design/)（按章节拆分，索引在 [design/README.md](./design/README.md)）。

## 本地启动

### 1. 启动 ClickHouse

所有持久化数据收敛在一个 `DATA_DIR` 根目录中：Node 使用 `sqlite3/`，ClickHouse 使用
`clickhouse/`。部署时只需持久化这一个根目录。下面的命令会启动名为 `log-ch` 的本地容器，
HTTP 端口为 `8123`，管理员账户为 `default / devpass`：

```bash
export DATA_DIR="/tmp/collect-log-data"
mkdir -p "$DATA_DIR/clickhouse"

docker run -d \
  --name log-ch \
  --ulimit nofile=262144:262144 \
  -p 8123:8123 \
  -p 9000:9000 \
  -e CLICKHOUSE_PASSWORD=devpass \
  -v "$DATA_DIR/clickhouse:/var/lib/clickhouse" \
  clickhouse/clickhouse-server:latest
```

### 2. 创建数据库和三个业务账户

三个账户的权限严格分离：`ch_ingest` 只能写业务数据，`ch_meta` 负责 `data.*` DDL 与
`system.*` 只读比对，`ch_readonly` 只能查询 `data.*`。`async_insert` 不配置到账户 profile，
只会在后续上报请求中作为 query-level setting 使用。

```bash
docker exec -i log-ch clickhouse-client \
  --user default \
  --password devpass \
  --multiquery <<'SQL'
CREATE DATABASE IF NOT EXISTS data;

CREATE USER IF NOT EXISTS ch_ingest IDENTIFIED WITH sha256_password BY 'ingest_pw';
CREATE USER IF NOT EXISTS ch_meta IDENTIFIED WITH sha256_password BY 'meta_pw';
CREATE USER IF NOT EXISTS ch_readonly IDENTIFIED WITH sha256_password BY 'readonly_pw';

GRANT INSERT ON data.* TO ch_ingest;

GRANT CREATE DATABASE ON *.* TO ch_meta;
GRANT SELECT, ALTER, CREATE TABLE, DROP TABLE ON data.* TO ch_meta;
GRANT SELECT ON system.* TO ch_meta;

GRANT SELECT ON data.* TO ch_readonly;
SQL
```

### 3. 安装并启动

需要 Node.js 当前 LTS 和 pnpm。复制本地配置后即可同时启动 server 与空白 web 骨架：

```bash
pnpm i
cp packages/server/.env.example packages/server/.env
pnpm dev
```

- server：`http://localhost:3000`
- 健康检查：`http://localhost:3000/healthz`
- web：`http://localhost:5173`

`packages/server/.env` 中的 CORS Origin 以英文逗号分隔。附录 A 的限额可通过
`LIMIT_<分组>_<配置名>` 形式覆盖，例如 `LIMIT_INGEST_MAX_BODY_BYTES=131072` 或
`LIMIT_QUERY_MAX_ROWS=20000`；未设置时严格使用设计文档默认值。

生产部署只需备份或挂载 `$DATA_DIR` 一个持久化根目录，其中 `sqlite3/app.db`（以及 WAL/SHM）
保存管理元数据，`clickhouse/` 保存 ClickHouse 数据。`sqlite3/` 应仅允许服务账户读写。

常用验证命令：

```bash
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm -r build
```
