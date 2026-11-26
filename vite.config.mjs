import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { createReadStream, cpSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const monacoRoot = join(dirname(require.resolve('monaco-editor/package.json')), 'min/vs');
function monacoAssets() {
  let outDir;
  return {
    name: 'self-hosted-monaco',
    configResolved(config) { outDir = config.build.outDir; },
    closeBundle() { cpSync(monacoRoot, join(outDir, 'monaco/vs'), { recursive: true }); },
    configureServer(server) {
      server.middlewares.use('/monaco/vs', (req, res, next) => {
        const path = (req.url || '').replace(/^\//, '').split('?')[0];
        if (!/^[\w./-]+$/.test(path) || path.split('/').includes('..')) return next();
        const file = join(monacoRoot, path);
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return next();
        res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.ttf') ? 'font/ttf' : 'text/javascript');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), monacoAssets()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001' } },
  build: { outDir: 'dist', sourcemap: false },
});
