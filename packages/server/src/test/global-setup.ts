import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vitest 的 setupFiles 跑在 worker 里，worker 被 tinypool 终止时不会触发 'exit'，
// 因此临时目录必须由主进程的 globalSetup teardown 负责清理。
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'collect-log-vitest-'));
  process.env.COLLECT_LOG_TEST_ROOT = root;

  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
