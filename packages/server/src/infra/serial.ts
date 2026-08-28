// src/infra/serial.ts —— 跨存储（ClickHouse DDL + SQLite 元数据）操作的唯一入口
let chain: Promise<unknown> = Promise.resolve();

export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}
