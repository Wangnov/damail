import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// 版本号（git 标签）和更新日志（标签附注），见 scripts/release-info.mjs
import { releaseInfo } from './scripts/release-info.mjs';

const release = releaseInfo();

export default defineConfig({
  plugins: [react()],
  define: { __APP_RELEASE__: JSON.stringify(release) },
  server: {
    port: Number(process.env.PORT ?? 5180),
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/mcp': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});
