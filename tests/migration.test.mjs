import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, createCipheriv } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { binary, backendEnvironment } from '../scripts/backend.mjs';
import { testServer, projectRoot } from './helpers.mjs';

test('旧版 SQLite 无损升级：原密码、内容、加密密钥、备份与幂等重启', async t => {
  let authorization = '';
  const mock = createServer((req, res) => { authorization = req.headers.authorization; req.resume(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => mock.close(r)));
  const key = randomBytes(32), salt = randomBytes(16).toString('hex'), password = 'legacy-password';
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), encrypted = Buffer.concat([cipher.update('legacy-model-key'), cipher.final()]);
  const modelKey = [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64')).join('.');
  const sourceId = crypto.randomUUID(), chunkId = crypto.randomUUID(), stamp = new Date().toISOString();
  const server = await testServer({ seed: async dataDir => {
    const legacy = (await readFile(join(projectRoot, 'backend/src/schema.inc'), 'utf8')).slice('R"SQL('.length, -')SQL"'.length);
    const db = new DatabaseSync(join(dataDir, 'knowledge.sqlite')); db.exec(legacy);
    const config = db.prepare('INSERT INTO config VALUES(?,?)'); config.run('password', salt + ':' + scryptSync(password, salt, 64).toString('hex')); config.run('model_api_key', modelKey); config.run('model_base_url', `http://127.0.0.1:${mock.address().port}/v1`); config.run('model_name', 'legacy-model');
    db.prepare('INSERT INTO sources(id,title,filename,type,size,created_at,updated_at,status) VALUES(?,?,?,?,?,?,?,?)').run(sourceId, '旧资料', '旧资料.md', 'markdown', 18, stamp, stamp, 'ready');
    db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?)').run(chunkId, sourceId, 1, '旧章节', '旧资料内容需要继续保留。', 0);
    db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), sourceId, chunkId, '旧笔记', '迁移前的个人理解。', stamp, stamp);
    db.prepare('INSERT INTO sessions VALUES(?,?)').run('old-session', Date.now() + 86400000); db.close();
    await writeFile(join(dataDir, '.encryption-key'), key);
  } }); t.after(() => server.close());
  const request = server.request;
  assert.equal((await request('/api/auth')).data.initialized, true);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password } })).status, 200);
  const auth = (await request('/api/auth')).data; assert.equal(auth.user.role, 'owner');
  const source = (await request(`/api/sources/${sourceId}`)).data; assert.equal(source.notes[0].content, '迁移前的个人理解。'); assert.equal(source.chunks[0].content, '旧资料内容需要继续保留。');
  assert.equal((await request('/api/settings/test', { method: 'POST' })).status, 200); assert.equal(authorization, 'Bearer legacy-model-key');
  assert.deepEqual(await readFile(join(server.dataDir, '.encryption-key')), key);
  const backups = await readdir(join(server.dataDir, 'backups')); assert.ok(backups.some(f => f.endsWith('.sqlite'))); assert.ok(backups.some(f => f.endsWith('.key')));
  await server.restart(); assert.equal((await request('/api/team')).data.members.length, 1);
  assert.deepEqual(await readdir(join(server.dataDir, 'backups')), backups);
  const exported = (await request('/api/export')).data; assert.ok(!JSON.stringify(exported).includes('legacy-model-key')); assert.ok(!JSON.stringify(exported).includes(password));
  await server.stop();
  await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--reset-owner-password'], { env: { ...backendEnvironment(), DATA_DIR: server.dataDir }, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(errors))); child.stdin.end('recovered-owner-password\n');
  });
  await server.start(); assert.equal((await request('/api/sources')).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'recovered-owner-password' } })).status, 200);
  assert.equal((await request(`/api/sources/${sourceId}`)).data.notes[0].title, '旧笔记');
});
