import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { testServer } from './helpers.mjs';

async function fixture(t) {
  const s = await testServer(); t.after(() => s.close());
  assert.equal((await s.request('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'upload-owner-123' } })).status, 201);
  const ownerCookie = s.getCookie();
  const start = files => s.request('/api/uploads', { method: 'POST', body: { category: '个人学习', files } });
  const chunk = (id, i, offset, raw, cookie = ownerCookie) => s.request(`/api/uploads/${id}/${i}?offset=${offset}`, { method: 'PUT', raw, headers: { 'Content-Type': 'application/octet-stream', cookie } });
  const finish = id => s.request(`/api/uploads/${id}/complete`, { method: 'POST' });
  const cancel = id => s.request(`/api/uploads/${id}`, { method: 'DELETE' });
  return { s, start, chunk, finish, cancel, ownerCookie };
}

test('分块上传：250 MB 上限、认证与归属、分块顺序、重启、过期和清理', async t => {
  const { s, start, chunk, finish, cancel, ownerCookie } = await fixture(t);
  const descriptor = { name: '教材.pdf', size: 250 * 1024 * 1024 };
  assert.equal((await s.request('/api/uploads', { method: 'POST', auth: false, body: { files: [descriptor] } })).status, 401);
  for (const size of [descriptor.size + 1, 0, -1, 1.5, '100']) assert.equal((await start([{ ...descriptor, size }])).status, 400);
  assert.equal((await start([{ ...descriptor, name: 'file.exe' }])).status, 400);
  assert.equal((await start(Array(6).fill(descriptor))).status, 400);
  const max = await start([descriptor]); assert.equal(max.status, 201); assert.equal(max.data.chunkSize, 1024 * 1024);
  assert.equal((await finish(max.data.id)).status, 409);
  assert.equal((await chunk(max.data.id, 0, 0, Buffer.alloc(8 * 1024 * 1024 + 1))).status, 400);
  assert.equal((await cancel(max.data.id)).status, 200);
  assert.equal((await cancel(max.data.id)).status, 404);
  const content = Buffer.from('# 分块测试\n重启后继续传输，保持文件字节和来源一致。');
  const batch = (await start([{ name: '分块笔记.md', size: content.length }])).data;
  const half = Math.floor(content.length / 2);
  assert.equal((await chunk(batch.id, 0, 1, content.subarray(0, half))).status, 409);
  assert.equal((await chunk(batch.id, 1, 0, content)).status, 400);
  assert.equal((await chunk(batch.id, 0, 0, content.subarray(0, half))).data.offset, half);
  assert.equal((await chunk(batch.id, 0, 0, content.subarray(0, half))).status, 200);
  assert.equal((await finish(batch.id)).status, 409);
  assert.equal((await s.request(`/api/uploads/${batch.id}`)).data.offsets[0], half);
  assert.equal((await chunk(batch.id,0,0,Buffer.alloc(half,33))).status,409);
  const invitation = (await s.request('/api/team/invitations', { method: 'POST', body: { role: 'editor' } })).data;
  await s.request('/api/auth/join', { method: 'POST', auth: false, body: { username: 'editor', password: 'editor-password', token: invitation.token, name: 'Editor' } });
  const otherCookie = s.getCookie();
  assert.equal((await chunk(batch.id, 0, half, content.subarray(half), otherCookie)).status, 404);
  assert.equal((await s.request(`/api/uploads/${batch.id}`, { method: 'DELETE' })).status, 404);
  const viewerInvite = (await s.request('/api/team/invitations', { method: 'POST', headers: { cookie: ownerCookie }, body: { role: 'viewer' } })).data;
  await s.request('/api/auth/join', { method: 'POST', auth: false, body: { username: 'viewer', password: 'viewer-password', token: viewerInvite.token, name: 'Viewer' } });
  assert.equal((await start([{ name: 'readonly.md', size: 10 }])).status, 403);
  await s.request('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'upload-owner-123' } });
  await s.restart();
  assert.equal((await chunk(batch.id, 0, half, content.subarray(half))).status, 200);
  const done = await finish(batch.id); assert.equal(done.status, 202); assert.equal(done.data[0].status, 'ready');
  const source = done.data[0]; assert.equal(source.size, content.length);
  assert.deepEqual(await readFile(join(s.dataDir, 'uploads', source.id)), content);
  assert.deepEqual(await readdir(join(s.dataDir, 'upload-staging')), []);
  const expired = (await start([{ name: 'expired.md', size: 20 }])).data;
  const path = join(s.dataDir, 'upload-staging', expired.id, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.expires = 1; await writeFile(path, JSON.stringify(manifest));
  assert.equal((await chunk(expired.id, 0, 0, Buffer.from('hello'))).status, 410);
  const fresh = await start([{ name: 'fresh.md', size: 20 }]); assert.equal(fresh.status, 201);
  assert.deepEqual(await readdir(join(s.dataDir, 'upload-staging')), [fresh.data.id]);
  assert.equal((await cancel(fresh.data.id)).status, 200);
});

test('分块上传：多文件内容去重与整批原子回滚', async t => {
  const { s, start, chunk, finish, cancel } = await fixture(t);
  const content = Buffer.from('# 已有资料\n这是一份用于验证内容指纹的原始资料。');
  const form = new FormData(); form.append('files', new Blob([content]), 'existing.md');
  assert.equal((await s.request('/api/sources/upload', { method: 'POST', raw: form })).status, 202);
  const fresh = Buffer.from('# 新资料\n本条内容应在后续文件重复时一起回滚。');
  const batch = (await start([{ name: 'new.md', size: fresh.length }, { name: 'duplicate.md', size: content.length }])).data;
  await chunk(batch.id, 0, 0, fresh); await chunk(batch.id, 1, 0, content);
  assert.equal((await finish(batch.id)).status, 409);
  assert.equal((await s.request('/api/sources')).data.length, 1);
  assert.equal((await readdir(join(s.dataDir, 'uploads'))).length, 1);
  assert.deepEqual(await readFile(join(s.dataDir, 'upload-staging', batch.id, '0')), fresh);
  assert.equal((await cancel(batch.id)).status, 200);
  const repeated = (await start([{ name: 'a.md', size: fresh.length }, { name: 'b.md', size: fresh.length }])).data;
  await chunk(repeated.id, 0, 0, fresh); await chunk(repeated.id, 1, 0, fresh);
  assert.equal((await finish(repeated.id)).status, 409);
  assert.equal((await s.request('/api/sources')).data.length, 1);
  await cancel(repeated.id);
});

test('分块上传：AI 解析选项、模型校验、后台任务与普通正文保留', async t => {
  const { s, chunk, finish } = await fixture(t);
  const { academicPdf } = await import('./pdf-fixture.mjs');
  const { createServer } = await import('node:http');
  const pdf = await academicPdf({ pages: 1 });
  const options = { category: '论文研究', parseMode: 'ai', aiPages: 1, files: [{ name: 'chunk-ai.pdf', size: pdf.length }] };
  assert.equal((await s.request('/api/uploads', { method: 'POST', body: options })).status, 400);
  const calls = [];
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    calls.push(JSON.parse(raw)); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ markdown: '# Chunked PDF AI\nReviewed text from the supplied PDF image.', blank: false, warnings: [] }) }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => { mock.closeAllConnections(); return new Promise(resolve => mock.close(resolve)); });
  assert.equal((await s.request('/api/settings', { method: 'PUT', body: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'vision-test' } })).status, 200);
  assert.equal((await s.request('/api/uploads', { method: 'POST', body: { ...options, aiPages: 51 } })).status, 400);
  const batch = await s.request('/api/uploads', { method: 'POST', body: options }); assert.equal(batch.status, 201);
  assert.equal((await chunk(batch.data.id, 0, 0, Buffer.from(pdf))).status, 200);
  const done = await finish(batch.data.id); assert.equal(done.status, 202, JSON.stringify(done.data));
  const source = done.data[0]; assert.equal(source.status, 'ready');
  let job;
  for (let i = 0; i < 150; i++) {
    job = (await s.request(`/api/sources/${source.id}/ai-parse`)).data;
    if (job.status === 'ready' || job.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(job.status, 'ready', JSON.stringify(job)); assert.equal(job.completed_pages, 1);
  assert.equal(calls.length, 1); assert.equal(calls[0].model, 'vision-test');
  const current = (await s.request(`/api/sources/${source.id}`)).data;
  assert.ok(current.chunks.length > 0); assert.ok(!current.chunks.some(c => c.content.includes('Reviewed text')));
});
