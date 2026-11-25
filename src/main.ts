import { readStartupConfig, parsePort, validateHost } from './config/startup.ts';
import { startServer } from './server.ts';

/** Parse supported launch overrides without changing the root .env or accepting unknown options. */
function startupArguments(args: string[]) {
  const config = readStartupConfig(process.cwd());
  let development = false;
  for (let index = 0; index < args.length; index++) {
    const [key, inline] = args[index].split('=', 2);
    if (key === '--dev' && inline === undefined) development = true;
    else if (key === '--host') {
      config.host =
        inline ??
        (args[index + 1] && !args[index + 1].startsWith('--') ? args[++index] : '0.0.0.0');
      validateHost(config.host);
    } else if (key === '--port') config.port = parsePort(inline ?? args[++index] ?? '');
    else throw new Error(`不支持的启动选项: ${key}`);
  }
  return { config, development };
}

/** Start the Node service and install graceful signal handlers after successful initialization. */
async function main(): Promise<void> {
  const { config, development } = startupArguments(process.argv.slice(2));
  const app = await startServer(process.cwd(), config, development);
  /** Release owned resources on process termination; repeated signals share the same shutdown. */
  const shutdown = (): void => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  console.info(`Stirrup Local: http://${host}:${config.port}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '服务启动失败');
  process.exitCode = 1;
});
