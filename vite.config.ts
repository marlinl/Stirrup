import { defineConfig } from 'vite';
import { acpPlugin } from './local/vite-plugin.ts';

export default defineConfig({
  plugins: [acpPlugin()],
  server: {
    host: '127.0.0.1',
    watch: { ignored: ['**/.env', '**/.env.*', '**/.local/**'] },
    fs: { allow: [process.cwd()], deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**'] },
  },
  preview: { host: '127.0.0.1' },
});
