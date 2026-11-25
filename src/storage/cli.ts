import { join } from 'node:path';
import { exportStorage, migrateStorage } from './legacy-json.ts';

/** Run an explicit offline import/export without touching login credentials or Agent-owned history. */
function main(): void {
  const directory = join(process.cwd(), '.local/web');
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const result = migrateStorage(directory);
    console.log(result.migrated ? 'SQLite 迁移完成' : '数据已迁移，无需重复导入');
    console.log(`项目：${result.projects}，对话：${result.conversations}`);
    if (result.backup) console.log(`旧 JSON 备份：${result.backup}`);
  } else if (args.length === 1 && args[0] === '--export') {
    console.log(`已验证的旧格式导出：${exportStorage(directory)}`);
    console.log('回退前保持服务停止，只替换项目索引和 conversations 目录，不替换认证文件。');
  } else throw new Error('用法：npm run storage:migrate 或 npm run storage:export');
}
try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : '存储迁移失败');
  process.exitCode = 1;
}
