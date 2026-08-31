## 附录 B：环境变量

```text
# 服务
PORT
LOG_LEVEL

# 持久化根目录（见 3.3.2），必须是绝对路径
# Node 使用 $DATA_DIR/sqlite3/app.db；$DATA_DIR/clickhouse 供 ClickHouse 容器挂载
DATA_DIR

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

# 限额覆盖（可选，全部见附录 A）
LIMIT_*
```

`DATA_DIR` **必须是绝对路径**：相对路径会随进程的工作目录漂移，同一份配置在
systemd、容器和本机 `pnpm dev` 下会指向三个不同的地方，而它下面放的是唯一一份元数据库。
启动时校验并在不合法时直接拒绝启动，比运行到一半发现连的是空库好。

