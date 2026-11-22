import { prepareEnrollment } from '../auth/passkey-store.ts';

/** Create a short-lived first-key binding link in the user's terminal without creating a login or private key. */
function main(): void {
  const port = process.argv[2] ?? '5173';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('用法：npm run passkey:setup -- [本地端口]');
  const token = prepareEnrollment(process.cwd());
  console.log(
    `在本机浏览器打开以下一次性入口（10 分钟内有效）：\nhttp://localhost:${port}/login#enroll=${token}\n按系统提示创建 Passkey；绑定后使用 Passkey 登录。`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : '无法准备 Passkey 绑定');
  process.exitCode = 1;
}
