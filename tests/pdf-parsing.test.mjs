import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { testServer } from './helpers.mjs';
import { academicPdf } from './pdf-fixture.mjs';

async function setup(t) {
  const server = await testServer(); t.after(() => server.close());
  const { request } = server;
  assert.equal((await request('/api/auth/setup', { method: 'POST', body: { password: 'pdf-parsing-test-password' } })).status, 201);
  const calls = []; let mode = 'normal', active = 0, peak = 0;
  const gate = Promise.withResolvers();
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push(body); active++; peak = Math.max(peak, active);
    res.on('close', () => active--);
    const prompt = body.messages[0].content[0].text;
    const page = Number(prompt.match(/PDF page (\d+)/)[1]);
    if (mode === 'blocked') await gate.promise;
    if (mode === 'slow') await delay(80);
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'failure') { res.writeHead(503); res.end('{}'); return; }
    const content = mode === 'invalid' ? 'not-json' : JSON.stringify({
      markdown: `# Page ${page}\nAIORDER${page} Left column paragraph.\n\n${page === 2 ? 'Middle column paragraph.\n\n' : ''}Right column paragraph.\n\n| Metric | Value |\n| --- | --- |\n| Delay | 12.5 ms |\n\n$E=mc^2$`,
      blank: false, warnings: ['Check formula symbols against the original.'],
    });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: mode === 'truncated' ? 'length' : 'stop' }] }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  t.after(() => { gate.resolve(); mock.closeAllConnections(); return new Promise(r => mock.close(r)); });
  const connection = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'ordinary-chat-model', pdfModel: 'vision-pdf-model', apiKey: 'pdf-secret-key' };
  const configure = () => request('/api/settings', { method: 'PUT', body: connection });
  const upload = async (name, bytes, extra = {}) => {
    const form = new FormData(); form.append('files', new Blob([bytes], { type: 'application/pdf' }), name);
    for (const [key, value] of Object.entries(extra)) form.append(key, String(value));
    return request('/api/sources/upload', { method: 'POST', raw: form });
  };
  const job = async id => (await request(`/api/sources/${id}/ai-parse`)).data;
  const waitJob = async (id, statuses = ['ready', 'failed', 'cancelled']) => {
    for (let i = 0; i < 150; i++) { const current = await job(id); if (statuses.includes(current.status)) return current; await delay(100); }
    throw new Error('PDF parse did not complete: ' + JSON.stringify(await job(id)) + '\n' + server.logs());
  };
  const start = (id, firstPage = 1, lastPage = 2) => request(`/api/sources/${id}/ai-parse`, { method: 'POST', body: { firstPage, lastPage } });
  const action = (id, jobId, action, body) => request(`/api/sources/${id}/ai-parse/${jobId}/${action}`, { method: 'POST', body });
  return { server, request, calls, connection, configure, upload, job, waitJob, start, action, gate, mode: value => { mode = value; }, peak: () => peak };
}

test('PDF AI 版面解析：双/三栏页面图片、后台进度、核对采用、检索和历史证据保护', { timeout: 60000 }, async t => {
  const f = await setup(t); const { request } = f;
  const bytes = await academicPdf();
  const ordinary = await f.upload('double-triple.pdf', bytes);
  assert.equal(ordinary.status, 202);
  const id = ordinary.data[0].id;
  const original = (await request(`/api/sources/${id}`)).data;
  assert.equal(original.status, 'ready'); assert.equal(original.pages, 2); assert.equal(f.calls.length, 0);
  const firstChunk = original.chunks.find(chunk => chunk.page === 1);
  assert.ok(firstChunk.content.indexOf('LEFTEND') < firstChunk.content.indexOf('RIGHTSTART'), '普通解析应按栏恢复阅读顺序');
  const triple = original.chunks.filter(chunk => chunk.page === 2).map(chunk => chunk.content).join('\n');
  assert.ok(triple.indexOf('LEFTEND') < triple.indexOf('MIDDLESTART') && triple.indexOf('MIDDLEEND') < triple.indexOf('RIGHTSTART'), '三栏普通解析按左、中、右排列');
  const note = (await request('/api/notes', { method: 'POST', body: { title: '历史引用', content: '核对前的笔记', source_id: id, chunk_id: firstChunk.id } })).data;
  const page = (await request('/api/wiki', { method: 'POST', body: { title: 'PDF 原始证据', kind: 'method', category: '论文研究', summary: '原始引用', body: '原始片段。[1]', tags: [], citations: [{ chunk_id: firstChunk.id }], related_ids: [] } })).data;
  assert.ok(page.id);
  assert.equal((await f.start(id)).status, 400, '未配置模型时不产生任务');
  assert.equal((await f.configure()).status, 200);
  const { pdfModel: ignored, ...oldSettings } = f.connection;
  assert.equal((await request('/api/settings', { method: 'PUT', body: oldSettings })).data.pdfModel, 'vision-pdf-model', '旧客户端省略 PDF 模型时保留设置');
  assert.equal((await request('/api/settings', { method: 'PUT', body: { ...oldSettings, pdfModel: 123 } })).status, 400);
  const ingestion = new DatabaseSync(join(f.server.dataDir, 'knowledge.sqlite'));
  ingestion.prepare("UPDATE sources SET status='processing' WHERE id=?").run(id);
  assert.equal((await f.start(id)).status, 202);
  for (let i = 0; i < 15; i++) {
    assert.equal((await f.job(id)).status, 'queued', '普通解析结束前不得运行 AI 任务');
    assert.equal(f.calls.length, 0); await delay(100);
  }
  ingestion.prepare("UPDATE sources SET status='ready' WHERE id=?").run(id); ingestion.close();
  const parsed = await f.waitJob(id);
  assert.equal(parsed.status, 'ready', parsed.error); assert.equal(parsed.completed_pages, 2); assert.equal(parsed.pages.length, 2);
  const preview = await fetch(f.server.base + `/api/sources/${id}/ai-parse/${parsed.id}/pages/2`, { headers: { cookie: f.server.getCookie() } });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await preview.arrayBuffer()).readUInt16BE(0), 0xffd8);
  assert.equal((await fetch(f.server.base + `/api/sources/${id}/ai-parse/${parsed.id}/pages/2`)).status, 401);
  assert.equal(f.peak(), 1, '页面模型请求串行处理');
  assert.equal((await f.start(id)).status, 409, '核对前不覆盖待采用结果');
  for (const body of f.calls) {
    assert.equal(body.model, 'vision-pdf-model'); assert.equal(body.max_completion_tokens, 8192);
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    const part = body.messages[0].content[1]; assert.equal(part.type, 'image_url'); assert.equal(part.image_url.detail, 'high');
    const prefix = 'data:' + 'image/jpeg;base64,';
    assert.ok(part.image_url.url.startsWith(prefix));
    const image = Buffer.from(part.image_url.url.slice(prefix.length), 'base64');
    assert.equal(image.readUInt16BE(0), 0xffd8, '发送真实渲染的 JPEG 页面'); assert.ok(image.length > 1000);
  }
  assert.equal((await request(`/api/sources/${id}`)).data.chunks[0].content, firstChunk.content, '核对前不替换正文');
  assert.equal((await request('/api/search?q=AIORDER1')).data.chunks.length, 0);
  const corrected = { corrections: [{ page: 1, content: '# Verified\nAIORDER1 Verified transcription from original PDF.' }] };
  const applied = await Promise.all([f.action(id, parsed.id, 'apply', corrected), f.action(id, parsed.id, 'apply', corrected)]);
  assert.deepEqual(applied.map(result => result.status).sort(), [200, 409], '两成员同时采用只允许一次成功');
  const adopted = (await request(`/api/sources/${id}`)).data;
  assert.equal(adopted.ai_pages, 2); assert.ok(adopted.chunks.every(chunk => chunk.active === 1));
  assert.ok(adopted.chunks.find(chunk => chunk.page === 1).content.includes('Verified transcription'));
  assert.equal(adopted.notes.find(n => n.id === note.id).chunk_id, firstChunk.id);
  const wiki = (await request(`/api/wiki/${page.id}`)).data;
  assert.equal(wiki.citations[0].chunk_id, firstChunk.id); assert.ok(wiki.citations[0].excerpt.includes('LEFTSTART'));
  const history = (await request(`/api/sources/${id}?chunk=${firstChunk.id}`)).data;
  assert.equal(history.chunks.find(chunk => chunk.id === firstChunk.id).content, firstChunk.content);
  assert.equal(history.chunks.find(chunk => chunk.id === firstChunk.id).active, 0);
  assert.ok((await request('/api/search?q=AIORDER1')).data.chunks.some(chunk => chunk.source_id === id));
  assert.equal((await request('/api/search?q=LEFTSTART')).data.chunks.length, 0, '历史解析不再参与新检索');
  assert.equal((await f.action(id, parsed.id, 'apply')).status, 409, '不能重复采用');
  await f.server.restart();
  assert.equal((await request(`/api/sources/${id}`)).data.ai_pages, 2);
  assert.equal((await request('/api/settings')).data.pdfModel, 'vision-pdf-model');
  const exported = (await request('/api/export')).data;
  assert.ok(exported.pdf_parse_jobs.length); assert.equal(exported.pdf_parse_pages.length, 2);
  assert.ok(!JSON.stringify(exported).includes('pdf-secret-key'));
});

test('PDF AI 边界：扫描页、局部采用、失败不覆盖、取消队列、范围与权限', { timeout: 60000 }, async t => {
  const f = await setup(t); const { request } = f; await f.configure();
  const missingModel = await f.upload('unsupported.txt', Buffer.from('text'), { parseMode: 'invalid' }); assert.equal(missingModel.status, 400);
  const upload = await f.upload('optional-ai.pdf', await academicPdf({ pages: 3 }), { parseMode: 'ai', aiPages: 1 });
  assert.equal(upload.status, 202); const id = upload.data[0].id;
  let job = await f.waitJob(id); assert.equal(job.status, 'ready', job.error); assert.equal(job.pages.length, 1);
  const before = (await request(`/api/sources/${id}`)).data;
  const page2 = before.chunks.find(c => c.page === 2);
  assert.equal((await f.action(id, job.id, 'apply', { corrections: [{ page: 99, content: 'invalid' }] })).status, 400);
  assert.equal((await f.action(id, job.id, 'apply')).status, 200);
  const after = (await request(`/api/sources/${id}`)).data;
  assert.equal(after.chunks.find(c => c.page === 2).id, page2.id, '未选页面不受影响');
  const activeIds = after.chunks.map(c => c.id);
  for (const mode of ['failure', 'invalid', 'truncated']) {
    f.mode(mode); assert.equal((await f.start(id, 2, 2)).status, 202);
    job = await f.waitJob(id); assert.equal(job.status, 'failed');
    assert.deepEqual((await request(`/api/sources/${id}`)).data.chunks.map(c => c.id), activeIds);
    assert.equal((await f.action(id, job.id, 'apply')).status, 409);
  }
  for (const [first, last] of [[0, 1], [1, 0], [1, 51], [1.5, 2], [1, 4], ['1', 2]]) assert.equal((await f.start(id, first, last)).status, 400);
  const invitation = (await request('/api/team/invitations', { method: 'POST', body: { role: 'viewer' } })).data;
  const response = await fetch(f.server.base + '/api/auth/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitation.token, username: 'pdfviewer', name: 'PDF Viewer', password: 'pdf-viewer-password' }) });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(f.server.base + `/api/sources/${id}/ai-parse`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(f.server.base + `/api/sources/${id}/ai-parse`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ firstPage: 1, lastPage: 1 }) })).status, 403);
  f.mode('blocked'); const oldCalls = f.calls.length;
  await f.start(id, 1, 1); job = await f.waitJob(id, ['running']);
  for (let i = 0; i < 100 && f.calls.length === oldCalls; i++) await delay(20);
  assert.equal(f.calls.length, oldCalls + 1, '确认模型请求已进入等待后测试取消');
  const blank = await f.upload('scanned-like.pdf', await academicPdf({ pages: 1, scanned: true }));
  assert.equal(blank.data[0].status, 'failed'); const blankId = blank.data[0].id;
  const queued = await f.start(blankId, 1, 1); assert.equal(queued.status, 202);
  assert.equal((await f.action(blankId, queued.data.id, 'cancel')).status, 200);
  assert.equal((await f.action(id, job.id, 'cancel')).status, 200);
  f.mode('normal');
  assert.equal((await f.job(id)).status, 'cancelled');
  await f.start(blankId, 1, 1); const scanned = await f.waitJob(blankId); assert.equal(scanned.status, 'ready', scanned.error);
  assert.equal((await f.action(blankId, scanned.id, 'apply')).status, 200);
  assert.equal((await request(`/api/sources/${blankId}`)).data.status, 'ready');
  const previewPath = join(f.server.dataDir, 'pdf-previews', blankId);
  await access(previewPath);
  assert.equal((await request(`/api/sources/${blankId}`, { method: 'DELETE' })).status, 200);
  await assert.rejects(access(previewPath), { code: 'ENOENT' });
  f.gate.resolve();
  assert.equal(f.calls.filter(body => body.messages[0].content[0].text.includes('page 1.')).length >= 1, true);
});

test('PDF v3 升级与中断恢复：迁移备份、原始片段不变、已完成页面保留', { timeout: 60000 }, async t => {
  const f = await setup(t); await f.configure();
  const upload = await f.upload('restart.pdf', await academicPdf({ pages: 1 })); const id = upload.data[0].id;
  const before = (await f.request(`/api/sources/${id}`)).data;
  await f.server.stop();
  const oldDb = new DatabaseSync(join(f.server.dataDir, 'knowledge.sqlite'));
  oldDb.exec("DROP TABLE pdf_parse_pages; DROP TABLE pdf_parse_jobs; DROP INDEX chunks_active_source; ALTER TABLE sources DROP COLUMN parse_revision; ALTER TABLE chunks DROP COLUMN active; ALTER TABLE chunks DROP COLUMN parse_job_id; UPDATE config SET value='3' WHERE key='schema_version'"); oldDb.close();
  await f.server.start();
  assert.deepEqual((await f.request(`/api/sources/${id}`)).data.chunks.map(c => c.id), before.chunks.map(c => c.id));
  f.mode('blocked'); await f.start(id, 1, 1); await f.waitJob(id, ['running']);
  await f.server.stop();
  const db = new DatabaseSync(join(f.server.dataDir, 'knowledge.sqlite'));
  const jobId = db.prepare('SELECT id FROM pdf_parse_jobs WHERE source_id=?').get(id).id;
  db.prepare('INSERT INTO pdf_parse_pages(job_id,page,content) VALUES(?,?,?)').run(jobId, 1, 'Persisted page result.');
  db.prepare('UPDATE pdf_parse_jobs SET completed_pages=1 WHERE id=?').run(jobId);
  db.close();
  f.gate.resolve(); f.mode('normal'); await f.server.start();
  const restored = await f.job(id); assert.equal(restored.status, 'failed'); assert.match(restored.error, /重启/);
  assert.equal(restored.pages[0].content, 'Persisted page result.');
  assert.deepEqual((await f.request(`/api/sources/${id}`)).data.chunks.map(c => c.id), before.chunks.map(c => c.id));
  const backups = await readdir(join(f.server.dataDir, 'backups')); assert.equal(backups.filter(name => name.endsWith('.sqlite')).length, 1);
  await f.server.restart(); assert.deepEqual(await readdir(join(f.server.dataDir, 'backups')), backups);
  assert.ok((await readFile(join(f.server.dataDir, 'knowledge.sqlite'))).length > 0);
});
