import { readSiteConfig } from './local/config/site.ts';
import { defineConfig } from 'vite';
import { acpPlugin } from './local/vite-plugin.ts';
import { readStartupConfig, startupConfigPlugin } from './local/config/startup.ts';

/** Read the app's startup environment before Vite opens a listener or creates the local runtime. */
export default defineConfig(() => {
  const startup = readStartupConfig(process.cwd());
  const site = readSiteConfig(process.cwd());
  const allowedHosts = [site.rpId];
  return {
    plugins: [startupConfigPlugin(), acpPlugin()],
    server: {
      ...startup,
      allowedHosts,
      strictPort: true,
      watch: { ignored: ['**/.env', '**/.env.*', '**/.local/**'] },
      fs: {
        allow: [process.cwd()],
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**'],
      },
    },
    preview: { ...startup, allowedHosts, strictPort: true },
  };
});
