import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:net';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export async function availablePort() { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
export async function testServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'zhixu-test-'));
  const port = await availablePort(), base = `http://127.0.0.1:${port}`;
  let child, logs = '', cookie = '';
  async function start() {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: projectRoot, env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Server did not start: ${logs}`);
  }
  async function stop() { if (!child || child.exitCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  async function request(path, { method = 'GET', body, raw, headers = {}, auth = true } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(auth && cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    const data = await response.json().catch(() => null);
    return { status: response.status, data, headers: response.headers };
  }
  async function ready(sourceId) {
    for (let i = 0; i < 200; i++) { const r = await request(`/api/sources/${sourceId}`); if (r.data?.status !== 'processing') return r.data; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('Import did not complete');
  }
  await start();
  return { base, port, dataDir, request, ready, getCookie: () => cookie, logs: () => logs, restart: async () => { await stop(); await start(); }, close: async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); } };
}
