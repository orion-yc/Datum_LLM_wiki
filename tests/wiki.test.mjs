import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { testServer } from './helpers.mjs';

async function fixture(t) {
  const server = await testServer(); t.after(() => server.close());
  const request = server.request;
  const call = async (path, method = 'GET', body) => request(path, { method, ...(body instanceof FormData ? { raw: body } : { body }) });
  assert.equal((await call('/api/auth/setup', 'POST', { password: 'wiki-test-password' })).status, 201);
  const upload = async (name, body) => {
    const form = new FormData(); form.append('files', new Blob([body]), name);
    const result = await call('/api/sources/upload', 'POST', form); assert.equal(result.status, 202, JSON.stringify(result.data));
    return (await call(`/api/sources/${result.data[0].id}`)).data;
  };
  return { server, call, upload };
}
const body = (title, source, extra = {}) => ({ title, kind: 'concept', category: '个人学习', summary: '人工核对的解释', tags: ['检索'], body: '这是结合原文的理解。[1]', citations: [{ chunk_id: source.chunks[0].id, source_id: source.id, excerpt: '伪造的文字应该被忽略' }], related_ids: [], ...extra });

test('Wiki：跨资料草稿、原文校验、发布门槛、并发版本、反向链接和历史恢复', async t => {
  const { server, call, upload } = await fixture(t);
  const a = await upload('方法甲.md', '# 原理\n有序序列上每次缩小候选区间。\n## 边界\n闭区间仍有元素时需要继续比较。');
  const b = await upload('方法乙.md', '# 实践\n检查首尾元素和空数组能够验证算法边界。\n## 限制\n没有排序保证时不能直接使用二分法。');
  let audit = (await call('/api/wiki/audit')).data; assert.equal(audit.issues.filter(i => i.kind === 'unorganized-source').length, 2);
  const proposal = (await call('/api/wiki/draft', 'POST', { title: '查找方法的适用条件', source_ids: [a.id, b.id] })).data;
  assert.equal(proposal.generation_mode, 'extract'); assert.equal(proposal.coverage.length, 2); assert.equal(proposal.citations.length, 4);
  assert.equal((await call('/api/wiki')).data.length, 0, '生成只是可编辑提案，不直接落库');
  assert.equal(new Set(proposal.citations.map(c => c.source_id)).size, 2); assert.ok(proposal.coverage.every(c => c.used_chunks === c.total_chunks));
  assert.equal((await call('/api/wiki/draft', 'POST', { title: '没有资料', source_ids: [] })).status, 400);
  assert.equal((await call('/api/wiki', 'POST', body('无效证据', a, { citations: [{ chunk_id: b.chunks[0].id, source_id: a.id }] }))).status, 400);
  assert.equal((await call('/api/wiki')).data.length, 0, '无效证据回滚正文和历史');
  let page = (await call('/api/wiki', 'POST', body('别名检索入口', a))).data;
  assert.equal(page._version, 1); assert.equal(page.status, 'draft'); assert.equal(page.citations[0].excerpt, a.chunks[0].content);
  const duplicate = (await call('/api/wiki', 'POST', { title: '别名 检索入口', body: '', citations: [], related_ids: [] })).data;
  const findings = (await call('/api/wiki/audit')).data.issues;
  assert.ok(findings.some(i => i.kind === 'duplicate-title')); assert.ok(findings.some(i => i.kind === 'missing-evidence')); assert.ok(findings.some(i => i.kind === 'empty-page'));
  assert.equal((await call(`/api/wiki/${duplicate.id}`, 'DELETE')).status, 200);
  let other = (await call('/api/wiki', 'POST', body('边界实践', b, { related_ids: [page.id] }))).data;
  assert.equal((await call(`/api/wiki/${page.id}`)).data.backlinks[0].id, other.id);
  assert.equal((await call(`/api/wiki/${page.id}`, 'DELETE')).status, 409, '反向链接保护');
  assert.equal((await call(`/api/sources/${a.id}`, 'DELETE')).status, 409, '原始证据删除保护');
  assert.equal((await call(`/api/wiki/${page.id}`, 'PUT', { ...page, related_ids: [page.id] })).status, 400);
  assert.equal((await call(`/api/wiki/${page.id}`, 'PUT', { ...page, _version: undefined })).status, 400);
  const saved = await call(`/api/wiki/${page.id}`, 'PUT', { ...page, body: '开方 $\\sqrt[1]{x}$ 与索引 `a[1]`。' }); assert.equal(saved.status, 200);
  const stale = await call(`/api/wiki/${page.id}`, 'PUT', page); assert.equal(stale.status, 409);
  page = saved.data;
  assert.equal((await call(`/api/wiki/${page.id}/state`, 'POST', { _version: page._version, status: 'published' })).status, 400);
  assert.ok((await call('/api/wiki/audit')).data.issues.some(i => i.kind === 'citation-markers'));
  page = (await call(`/api/wiki/${page.id}`, 'PUT', { ...page, body: '不能使用虚构编号。[99]' })).data;
  assert.equal((await call(`/api/wiki/${page.id}/state`, 'POST', { _version: page._version, status: 'published' })).status, 400);
  page = (await call(`/api/wiki/${page.id}`, 'PUT', { ...page, body: '结合原文核对过的根式 $\\sqrt[99]{x}$。[1]' })).data;
  const comment = (await call('/api/comments', 'POST', { kind: 'wiki', target_id: page.id, content: '需要再次核对适用条件' })).data;
  assert.equal((await call(`/api/wiki/${page.id}/state`, 'POST', { _version: page._version, status: 'published' })).status, 409);
  await call(`/api/comments/${comment.id}`, 'PATCH', { resolved: true });
  page = (await call(`/api/wiki/${page.id}/state`, 'POST', { _version: page._version, status: 'published' })).data;
  assert.equal(page.status, 'published'); assert.equal((await call(`/api/wiki/${page.id}`, 'PUT', page)).status, 409);
  const h = (await call(`/api/wiki/${page.id}/history`)).data;
  assert.equal(h.length, page._version); assert.equal(h.at(-1).snapshot.citations[0].excerpt, a.chunks[0].content);
  const exported = await fetch(`${server.base}/api/wiki/${page.id}/export`, { headers: { cookie: server.getCookie() } });
  assert.match(exported.headers.get('content-type'), /text\/markdown/); const md = await exported.text(); assert.match(md, /原文依据/); assert.ok(md.includes(a.chunks[0].content));
  await server.restart(); assert.equal((await call(`/api/wiki/${page.id}`)).data.status, 'published');
  page = (await call(`/api/wiki/${page.id}/restore`, 'POST', { _version: page._version, history_id: h.at(-1).id })).data;
  assert.equal(page.status, 'draft'); assert.equal(page.body, '这是结合原文的理解。[1]');
  const exportedAll = (await call('/api/export')).data; assert.equal(exportedAll.version, 4); assert.equal(exportedAll.wiki_pages.length, 2); assert.equal(exportedAll.wiki_links.length, 1); assert.equal(exportedAll.wiki_evidence.length, 2);
  const task = await call('/api/tasks', 'POST', { kind: 'wiki', target_id: other.id, title: '整理关联页' }); assert.equal(task.status, 201);
  const deleteOther = await call(`/api/wiki/${other.id}`, 'DELETE'); assert.equal(deleteOther.status, 200);
  assert.equal((await call('/api/tasks')).data.length, 0); assert.equal((await call(`/api/wiki/${page.id}`)).data.backlinks.length, 0);
  assert.equal((await call(`/api/wiki/${page.id}`, 'DELETE')).status, 200); assert.equal((await call(`/api/sources/${a.id}`, 'DELETE')).status, 200);
});

test('Wiki 检索：已发布页面引导原文、草稿隔离、固定资料范围和持久化检索线索', async t => {
  const { server, call, upload } = await fixture(t);
  const a = await upload('边界依据.md', '# 有序查找\n每一步都排除已经比较过的中间位置，维护候选区间。');
  const b = await upload('其他资料.md', '# 花卉养护\n植物叶绿体进行光合作用，冬季需要注意保温。');
  let page = (await call('/api/wiki', 'POST', body('boundarybridgealias', a))).data;
  const chat = (await call('/api/conversations', 'POST', {})).data;
  const ask = async (id, content) => (await call(`/api/conversations/${id}/messages`, 'POST', { content })).data.messages.at(-1);
  assert.equal((await ask(chat.id, 'boundarybridgealias')).mode, 'insufficient');
  page = (await call(`/api/wiki/${page.id}/state`, 'POST', { _version: page._version, status: 'published' })).data;
  const answer = await ask(chat.id, 'boundarybridgealias'); assert.equal(answer.mode, 'extract'); assert.equal(answer.citations[0].chunk_id, a.chunks[0].id); assert.equal(answer.citations[0].wiki_pages[0].id, page.id);
  assert.equal(answer.citations[0].wiki_pages[0].version, page._version); assert.equal(answer.citations[0].excerpt, a.chunks[0].content);
  const scoped = (await call('/api/conversations', 'POST', { source_id: b.id })).data;
  assert.equal((await ask(scoped.id, 'boundarybridgealias')).mode, 'insufficient', '知识页不能突破固定资料范围');
  const search = (await call('/api/search?q=boundarybridgealias')).data; assert.equal(search.wiki[0].id, page.id); assert.equal(search.chunks[0].id, a.chunks[0].id);
  await server.restart(); assert.equal((await call(`/api/conversations/${chat.id}`)).data.messages.at(-1).citations[0].wiki_pages[0].id, page.id);
  page = (await call(`/api/wiki/${page.id}/state`, 'POST', { _version: page._version, status: 'draft' })).data;
  assert.equal((await ask(chat.id, 'boundarybridgealias')).mode, 'insufficient');
  assert.equal((await call('/api/search?q=boundarybridgealias')).data.wiki[0].id, page.id, '草稿仍可通过目录搜索找到');
  const repeated = 'diversitykeyword 这是完全相同的正文，重复片段不应占满答案。';
  await upload('重复片段.md', Array.from({ length: 10 }, (_, i) => `## 位置${i}\n${repeated}`).join('\n'));
  const unique = await upload('补充证据.md', '# 补充\ndiversitykeyword 这是另一份资料的独立证据，用于验证资料覆盖。');
  const diversity = (await call('/api/search?q=diversitykeyword')).data.chunks;
  assert.equal(diversity.filter(c => c.content === repeated).length, 1, '规范化正文去重');
  assert.ok(diversity.some(c => c.source_id === unique.id), '保留其他资料的证据');
  const invite = (await call('/api/team/invitations', 'POST', { role: 'viewer' })).data;
  let response = await fetch(server.base + '/api/auth/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite.token, username: 'reader', name: '只读者', password: 'reader-password' }) });
  assert.equal(response.status, 201); const cookie = response.headers.get('set-cookie').split(';')[0];
  for (const path of ['/api/wiki', '/api/wiki/audit', `/api/wiki/${page.id}`, `/api/wiki/${page.id}/history`, `/api/wiki/${page.id}/export`]) assert.equal((await fetch(server.base + path, { headers: { cookie } })).status, 200);
  for (const [path, method, b] of [['/api/wiki', 'POST', body('拒绝', a)], ['/api/wiki/draft', 'POST', { title: '拒绝', source_ids: [a.id] }], [`/api/wiki/${page.id}/state`, 'POST', { status: 'published', _version: page._version }], [`/api/wiki/${page.id}`, 'DELETE', {}]]) assert.equal((await fetch(server.base + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status, 403);
});

test('Wiki 模型：受限多来源输入、引用格式校验、失败不改库和保存时重新验证来源', async t => {
  const { call, upload } = await fixture(t);
  let fail = false, invalid = false, payload;
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    payload = JSON.parse(raw); if (fail) { res.writeHead(503); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '模型归纳的草稿', body: invalid ? '虚构引用。[999]' : '在有序前提下进行边界验证。[1]' }) } }] }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => mock.close(r)));
  const source = await upload('长篇资料.md', Array.from({ length: 42 }, (_, i) => `## 第${i}节\n这是不同位置的证据片段${i}，描述测试方法和验证前提。`).join('\n'));
  await call('/api/settings', 'PUT', { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'wiki-mock', reasoningEffort: 'xhigh' });
  const options = { title: '验证方法', source_ids: [source.id], question: '适用条件' };
  const proposal = await call('/api/wiki/draft', 'POST', options); assert.equal(proposal.status, 200);
  assert.equal(payload.reasoning_effort, 'xhigh'); assert.equal(Object.hasOwn(payload, 'temperature'), false);
  assert.equal(proposal.data.generation_mode, 'model'); assert.equal(proposal.data.coverage[0].used_chunks, 20);
  const { evidence, kind } = JSON.parse(payload.messages[1].content);
  assert.equal(kind, 'concept'); assert.equal(evidence.length, 20); assert.ok(evidence.some(e => e.heading === '第41节'));
  invalid = true; assert.equal((await call('/api/wiki/draft', 'POST', options)).status, 502);
  invalid = false; fail = true; assert.equal((await call('/api/wiki/draft', 'POST', options)).status, 502);
  assert.equal((await call('/api/wiki')).data.length, 0);
  assert.equal((await call(`/api/sources/${source.id}`, 'DELETE')).status, 200);
  assert.equal((await call('/api/wiki', 'POST', proposal.data)).status, 404, '生成后原文被删除不能保存悬空证据');
  assert.equal((await call('/api/wiki')).data.length, 0);
});

test('全文导读逐段保存，前文衔接，失败续接后完整覆盖全部片段', async t => {
  const { server, call, upload } = await fixture(t);
  const source = await upload('长文.md', Array.from({ length: 42 }, (_, i) =>
    `## 概念${i + 1}\n学习本节原理并验证对应例子 ${i + 1}。`).join('\n'));
  const path = `/api/wiki/study/${source.id}`;
  assert.equal((await call(path)).data.configured, false);
  const inputs = [];
  let invalid = false;
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(JSON.parse(raw).messages[1].content);
    inputs.push(input);
    const content = { title: input.evidence[0].heading, summary: input.evidence[0].content,
      body: invalid ? '无效引用。[999]' : '对应概念的原理与应用。[1]' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => model.close(r)));
  await call('/api/settings', 'PUT', { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'study-mock' });
  const { configured, parts } = (await call(path)).data;
  assert.equal(configured, true);
  assert.ok(parts.length > 1 && parts.every(p => !p.saved));
  const generate = part => call(path, 'POST', { part_id: part.id });
  assert.equal((await generate(parts[1])).status, 409);
  assert.equal(inputs.length, 0);
  const cited = [], texts = [], previous = [];
  for (const [i, part] of parts.entries()) {
    if (i === 1) {
      invalid = true;
      assert.equal((await generate(part)).status, 502);
      assert.equal((await call('/api/wiki')).data.length, 1);
      await server.restart();
      assert.deepEqual((await call(path)).data.parts.filter(p => p.saved).map(p => p.id), [parts[0].id]);
      invalid = false;
    }
    const result = await generate(part);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const page = (await call(`/api/wiki/${part.id}`)).data;
    const { evidence, previous: context } = inputs.at(-1);
    texts.push(...evidence.map(e => e.content));
    cited.push(...page.citations.map(c => c.chunk_id));
    assert.equal(page.status, 'draft');
    assert.deepEqual(page.related_ids, i ? [parts[i - 1].id] : []);
    assert.deepEqual(context, previous.slice(-4));
    previous.push({ title: page.title, summary: page.summary });
    const calls = inputs.length;
    assert.equal((await generate(part)).data.id, part.id);
    assert.equal(inputs.length, calls, '已保存段落不能重复调用模型');
  }
  const pages = (await call('/api/wiki')).data;
  assert.ok(pages[0].system_id);
  assert.ok(pages.every(p => p.system_id === pages[0].system_id), '整本导读各段归入同一体系');
  assert.deepEqual(cited, source.chunks.map(c => c.id));
  assert.deepEqual(texts, source.chunks.map(c => c.content));
  assert.ok((await call(path)).data.parts.every(p => p.saved));
});

test('内容指纹：重命名与批量重复回滚、并发上传、v2 自动备份升级和历史重复检查', async t => {
  const { server, call, upload } = await fixture(t);
  const original = '# 不重复导入\n原始资料需要保留且避免被不同文件名重复上传。';
  const a = await upload('原文件.md', original);
  const form = new FormData(); form.append('files', new Blob(['# 新文件\n本批次的新文件也应该回滚。']), '新文件.md'); form.append('files', new Blob([original]), '改名文件.md');
  assert.equal((await call('/api/sources/upload', 'POST', form)).status, 409); assert.equal((await call('/api/sources')).data.length, 1);
  const makeForm = () => { const f = new FormData(); f.append('files', new Blob(['# 并发\n相同资料的两次上传只能写入一次。']), '并发.md'); return f; };
  const concurrent = await Promise.all([call('/api/sources/upload', 'POST', makeForm()), call('/api/sources/upload', 'POST', makeForm())]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [202, 409]);
  await server.stop();
  const key = await readFile(join(server.dataDir, '.encryption-key'));
  const db = new DatabaseSync(join(server.dataDir, 'knowledge.sqlite'));
  const duplicateId = crypto.randomUUID();
  db.prepare("INSERT INTO sources(id,title,filename,type,size,status,created_at,updated_at) SELECT ?,title||'历史副本',filename,type,size,status,created_at,updated_at FROM sources WHERE id=?").run(duplicateId, a.id);
  await writeFile(join(server.dataDir, 'uploads', duplicateId), original);
  db.exec("UPDATE config SET value='2' WHERE key='schema_version'; DROP TABLE wiki_links; DROP TABLE wiki_evidence; DROP TABLE wiki_history; DROP TABLE wiki_pages; DROP INDEX source_hash; ALTER TABLE sources DROP COLUMN content_hash;"); db.close();
  await server.start(); assert.equal((await call('/api/wiki')).status, 200);
  assert.equal((await call('/api/wiki/audit')).data.issues.filter(i => i.kind === 'duplicate-source').length, 2);
  const renamed = new FormData(); renamed.append('files', new Blob([original]), '再次改名.md');
  assert.equal((await call('/api/sources/upload', 'POST', renamed)).status, 409, 'v2 文件补建指纹');
  assert.equal((await call(`/api/sources/${a.id}`)).data.chunks[0].content, a.chunks[0].content);
  assert.deepEqual(await readFile(join(server.dataDir, '.encryption-key')), key);
  const backups = await readdir(join(server.dataDir, 'backups')); assert.equal(backups.filter(f => f.endsWith('.sqlite')).length, 1);
  await server.restart(); assert.deepEqual(await readdir(join(server.dataDir, 'backups')), backups);
});

test('Wiki 批量删除校验版本、权限与外部引用，并允许删除一组互相关联的页面', async t => {
  const { server, call, upload } = await fixture(t);
  const source = await upload('原文.md', '# 原文\n这是测试资料中的完整一句话。');
  const page = async (title, related_ids = []) =>
    (await call('/api/wiki', 'POST', body(title, source, { related_ids }))).data;
  let a = await page('主概念');
  const b = await page('配套概念', [a.id]);
  a = (await call('/api/wiki/' + a.id, 'PUT', { ...a, related_ids: [b.id] })).data;
  const external = await page('外部导读', [a.id]);
  const ids = [b.id, a.id], versions = { [a.id]: a._version, [b.id]: b._version };
  const path = '/api/wiki/batch-delete';
  const del = (payload = { ids, versions }) => call(path, 'POST', payload);
  assert.equal((await del({ ids, versions: {} })).status, 400);
  assert.equal((await del({ ids, versions: { ...versions, [a.id]: a._version + 1 } })).status, 409);
  const blocked = await del();
  assert.equal(blocked.status, 409); assert.match(blocked.data.error, /主概念/); assert.match(blocked.data.error, /外部导读/);
  assert.deepEqual((await call('/api/wiki/' + b.id)).data.related_ids, [a.id]);
  assert.equal((await call('/api/wiki/' + external.id, 'DELETE')).status, 200);
  a = (await call('/api/wiki/' + a.id + '/state', 'POST', { _version: a._version, status: 'published' })).data;
  versions[a.id] = a._version;
  const invite = (await call('/api/team/invitations', 'POST', { role: 'editor' })).data;
  const editor = await fetch(server.base + '/api/auth/join', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: invite.token, username: 'batch-editor', name: '编辑', password: 'wiki-test-password' }) });
  assert.equal(editor.status, 201);
  const denied = await fetch(server.base + path, { method: 'POST', headers: {
    cookie: editor.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, versions }) });
  assert.equal(denied.status, 403); assert.equal((await call('/api/wiki/' + b.id)).status, 200);
  assert.deepEqual((await del()).data, { deleted: ids });
  await server.restart();
  assert.deepEqual((await call('/api/wiki')).data, []);
  assert.equal((await call('/api/sources/' + source.id)).status, 200);
});

test('知识体系按来源归组、跨体系关联、批量移动回滚和持久化', async t => {
  const { server, call, upload } = await fixture(t);
  const a = await upload('数学基础.md', '# 矩阵\n矩阵可以表示一个线性变换。');
  const b = await upload('图像处理.md', '# 图像\n在图像坐标系中应用线性变换。');
  const save = async (data) => {
    const r = await call('/api/wiki', 'POST', data);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const x = await save(body('矩阵', a));
  const y = await save(body('图像变换', b, { related_ids: [x.id] }));
  const cross = await save(body('两种观点', a, { citations: [...x.citations, ...y.citations] }));
  assert.ok(x.system_id && y.system_id && x.system_id !== y.system_id);
  assert.equal(cross.system_id, null);
  assert.equal(y.related[0].system_id, x.system_id);
  assert.equal((await call('/api/wiki/' + x.id)).data.backlinks[0].system_id, y.system_id);
  const named = (await call('/api/wiki/systems', 'POST', { title: '应用方法' })).data;
  assert.ok(named.id);
  const target = (await call('/api/wiki/systems/' + named.id, 'PUT', { title: '应用数学' })).data;
  assert.equal(target.title, '应用数学');
  const explicit = await save(body('指定体系', a, { system_id: target.id }));
  assert.equal(explicit.system_id, target.id);
  assert.equal((await save(body('暂缓归类', a, { system_id: null }))).system_id, null);
  const { system_id, ...legacyUpdate } = explicit;
  assert.equal((await call('/api/wiki/' + explicit.id, 'PUT', legacyUpdate)).data.system_id, target.id);
  const versions = { [x.id]: x._version, [cross.id]: cross._version };
  const move = ver => call('/api/wiki/batch-move', 'POST', { ids: [x.id, cross.id], versions: ver, system_id: named.id });
  assert.equal((await move({ ...versions, [cross.id]: cross._version + 1 })).status, 409);
  assert.equal((await call('/api/wiki/' + x.id)).data.system_id, x.system_id);
  assert.equal((await move(versions)).status, 200);
  await server.restart();
  assert.equal((await call('/api/wiki/' + x.id)).data.system_id, target.id);
  assert.equal((await call('/api/wiki/' + y.id)).data.related[0].system_id, target.id);
  assert.equal((await call('/api/wiki/' + cross.id)).data.system_id, target.id);
});

test('旧 Wiki 迁移只按唯一来源归组，保留链接与已核对页面', async t => {
  const { server, call, upload } = await fixture(t);
  const a = await upload('线性代数.md', '# 向量\n向量可以按照坐标来表示。');
  const b = await upload('微积分.md', '# 导数\n导数表示局部变化率。');
  const x = (await call('/api/wiki', 'POST', body('线性空间', a))).data;
  const mixed = (await call('/api/wiki', 'POST', body('对照', b, {
    citations: [...x.citations, { chunk_id: b.chunks[0].id, source_id: b.id }], related_ids: [x.id],
  }))).data;
  const manual = (await call('/api/wiki', 'POST', { title: '自拟主题', citations: [], related_ids: [] })).data;
  const published = (await call('/api/wiki/' + x.id + '/state', 'POST', { status: 'published', _version: x._version })).data;
  await server.stop();
  const db = new DatabaseSync(join(server.dataDir, 'knowledge.sqlite'));
  db.exec("DROP INDEX wiki_pages_system; ALTER TABLE wiki_pages DROP COLUMN system_id; DROP TABLE wiki_system_sources; DROP TABLE wiki_systems; UPDATE config SET value='9' WHERE key='schema_version';");
  db.close();
  await server.start();
  const systems = (await call('/api/wiki/systems')).data;
  assert.equal(systems.length, 1);
  const migrated = (await call('/api/wiki/' + x.id)).data;
  assert.equal(migrated.system_id, systems[0].id);
  assert.equal(migrated.status, 'published'); assert.equal(migrated._version, published._version);
  assert.equal(migrated.backlinks[0].id, mixed.id);
  for (const page of [mixed, manual]) assert.equal((await call('/api/wiki/' + page.id)).data.system_id, null);
  const another = (await call('/api/wiki', 'POST', body('向量加法', a))).data;
  assert.equal(another.system_id, migrated.system_id);
  await server.restart();
  assert.deepEqual((await call('/api/wiki/systems')).data, systems);
});

test('Wiki 选区提问读取当前版本正文，处理渲染后的选区并保留知识页', async t => {
  const { call } = await fixture(t);
  const wiki = (await call('/api/wiki', 'POST', { title: '集合运算', kind: 'concept',
    body: '开头标记' + '前文。'.repeat(1500) + '\n## 定义\n集合的 **交集** 是 $A \\cap B$。',
    summary: '交集的定义', citations: [], related_ids: [] })).data;
  const ask = overrides => call(`/api/wiki/${wiki.id}/ask-selection`, 'POST', {
    quote: '交集', question: '请举个例子。', _version: wiki._version, ...overrides,
  });
  assert.equal((await ask({})).status, 400);
  const inputs = [];
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    inputs.push(JSON.parse(JSON.parse(raw).messages[1].content));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: '两个集合共同的元素构成**交集**。' } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => model.close(resolve)));
  await call('/api/settings', 'PUT', { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'qa-fixture' });
  for (const invalid of [{quote:' '}, {quote:'x'.repeat(4001)}, {question:''}, {question:'x'.repeat(2001)}])
    assert.equal((await ask(invalid)).status, 400);
  assert.equal((await ask({_version: wiki._version + 1})).status, 409);
  assert.equal(inputs.length, 0);
  const result = await ask({context:'伪造上下文'});
  assert.equal(result.status, 200);
  assert.match(result.data.answer, /\*\*交集\*\*/);
  assert.equal(inputs[0].title, wiki.title);
  assert.match(inputs[0].context, /## 定义/);
  assert.doesNotMatch(inputs[0].context, /伪造上下文|开头标记/);
  assert.equal(inputs[0].question, '请举个例子。');
  const rendered = '集合的 交集 是 A ∩ B。';
  assert.equal((await ask({quote:rendered})).status, 200);
  assert.equal(inputs[1].quote, rendered);
  assert.equal(inputs[1].context, wiki.body);
  assert.equal((await call(`/api/wiki/${wiki.id}`)).data._version, wiki._version);
});

test('Wiki 改写预览使用原文证据和编辑器范围，可继续修订并保留原草稿', async t => {
  const { call, upload } = await fixture(t);
  const source = await upload('rewrite.md', '# 规则\n只有有序数组才能使用这个二分查找步骤。');
  const content = '😀重复。\n## 下一节\n重复。[1]';
  const page = (await call('/api/wiki', 'POST', body('查找', source, { body:content }))).data;
  const start = content.lastIndexOf('重复');
  const input = { ...page, scope:'selection', start, end:start+2, feedback:'为什么能排除另一半？',
    citations: [{ chunk_id:source.chunks[0].id, source_id:source.id, excerpt:'客户端伪造的证据' }] };
  const rewrite = overrides => call('/api/wiki/rewrite','POST',{ ...input, ...overrides });
  assert.equal((await rewrite({})).status,400);
  const requests = [];
  let output = {body:'有序才能排除一半。', summary:'忽略局部改写返回的摘要'};
  const model = createServer(async (req,res) => {
    let raw=''; for await (const part of req) raw+=part;
    requests.push(JSON.parse(JSON.parse(raw).messages[1].content));
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ choices:[{message:{content:JSON.stringify(output)}}] }));
  });
  await new Promise(resolve => model.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => model.close(resolve)));
  await call('/api/settings','PUT',{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'rewrite-test'});
  for (const patch of [{start:1}, {scope:'page'}, {citations:[...input.citations,...input.citations]}, {feedback:'长'.repeat(2001)}])
    assert.equal((await rewrite(patch)).status,400);
  assert.equal((await rewrite({_version:page._version+1})).status,409);
  assert.equal(requests.length,0);
  const first=await rewrite({});
  assert.equal(first.status,200);
  assert.deepEqual(first.data,{body:output.body,summary:page.summary});
  assert.equal(requests[0].original,'重复');
  assert.equal(requests[0].before,content.slice(0,start));
  assert.equal(requests[0].evidence[0].content,source.chunks[0].content);
  assert.doesNotMatch(JSON.stringify(requests[0]),/客户端伪造/);
  const section = await rewrite({scope:'section',start:content.indexOf('##'),end:content.length,previous:first.data,feedback:'请简化例子。'});
  assert.deepEqual(requests[1].previous,first.data);
  assert.equal(requests[1].feedback,'请简化例子。');
  assert.equal(section.status,502,'移除最后一处证据标记应提示重试');
  const padded = await rewrite({scope:'section',body:'\n\n示例\n\n后文[1]',start:0,end:6});
  assert.equal(padded.status,200);
  assert.equal(padded.data.body,'\n\n'+output.body+'\n\n');
  output={body:'## 原理\n解释有序性。[1]', summary:'二分查找的前提'};
  const full={id:'',scope:'page',start:0,end:content.length};
  assert.deepEqual((await rewrite(full)).data,output);
  output.body='不存在的引用 [9]';
  assert.equal((await rewrite(full)).status,502);
  assert.equal((await call('/api/wiki/'+page.id)).data.body,content);
  assert.equal((await call('/api/wiki/'+page.id+'/history')).data.length,1);
  const pub=await call('/api/wiki/'+page.id+'/state','POST',{status:'published',_version:page._version});
  assert.equal(pub.status,200);
  assert.equal((await rewrite({_version:pub.data._version})).status,409);
});

test('书籍目录按人工确认的章节生成，可试读和续做，沿用旧知识页', async t => {
  const {server, call, upload} = await fixture(t);
  const book = await upload('学习数组.md', ['# 第一章 数组','数组表示顺序数据。',
    '## 存储','每个元素占用存储空间。','# 第二章 查找','可以循序查找元素。'].join('\n'));
  const url = '/api/wiki/book/'+book.id;
  const plan = (await call(url)).data;
  assert.equal(plan.confirmed,false);
  const entries = [{title:'数组',first:1,level:1},{title:'存储',first:2,level:2},{title:'查找',first:3,level:1}];
  const prior=(await call('/api/wiki','POST',body('已有查找笔记',book,{citations:[{source_id:book.id,chunk_id:book.chunks.at(-1).id}]}))).data;
  entries[2].reuse_id=prior.id;
  const confirm = await call(url,'POST',{action:'confirm',version:plan.version,entries});
  assert.ok(confirm.status < 300, JSON.stringify(confirm.data));
  assert.equal(confirm.data.entries.length,3);
  assert.equal(confirm.data.entries[0].last,2);
  assert.equal((await call(url,'POST',{action:'confirm',version:plan.version,entries})).status,409);
  let calls=0;
  const model=createServer(async (req,res)=>{
    let raw=''; for await(const piece of req) raw+=piece;
    const payload=JSON.parse(raw);
    assert.ok(payload.messages.length);
    calls++;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'示例章节',summary:'数组存储导读',body:'## 存储原理\n按顺序排列元素。[1]',links:[]})}}]}));
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>model.close(resolve)));
  await call('/api/settings','PUT',{baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',model:'book-mock'});
  let current=confirm.data;
  const trial=current.entries[0].id;
  for(let i=0;i<10 && !current.entries[0].wiki_id;i++){
    const result=await call(url,'POST',{action:'generate',entry_id:trial,version:current.version});
    assert.ok(result.status < 300,JSON.stringify(result.data));current=result.data;
  }
  const id=current.entries[0].wiki_id;
  assert.ok(id);assert.ok(calls);
  assert.equal(current.entries.filter(e=>e.wiki_id).length,2);
  assert.equal(current.entries[2].wiki_id,prior.id);
  assert.equal((await call('/api/wiki/'+prior.id)).data._version,prior._version);
  const before=calls;
  const repeated=await call(url,'POST',{action:'generate',entry_id:trial,version:current.version});
  assert.ok(repeated.status<300,JSON.stringify(repeated.data));assert.equal(calls,before);
  await server.restart();
  assert.equal((await call(url)).data.entries[0].wiki_id,id);
  const draft=(await call('/api/wiki/'+id)).data;
  assert.equal(draft.status,'draft');assert.ok(draft.citations.length);
  const directory=await call('/api/wiki/systems/'+draft.system_id+'/books');
  assert.ok(directory.data[0],JSON.stringify({dir:directory.data,code:directory.status,system:draft.system_id,plan:current.system_id,prior:prior.system_id}));
  assert.equal(directory.data[0].source_id,book.id);
  assert.equal(directory.data[0].entries[0].wiki_id,id);
});

test('论文精读生成一篇可编辑中文导读，方法、实验与局限均可追溯到英文原文', async t => {
  const { call, upload } = await fixture(t);
  const sections = Array.from({ length: 48 }, (_, i) => ['Section '+i, 'Background discussion in the paper.']);
  sections[0] = ['Abstract', 'We investigate sample efficiency.'];
  sections[7] = ['Methods', 'We introduce importance sampling.'];
  sections[27] = ['Experiments', 'The evaluation compares two baseline models.'];
  sections[34] = ['Results', 'Table 1 reports a reduction in error from 12% to 9%.'];
  sections[46] = ['Limitations', 'The samples contain only English documents.'];
  const article = await upload('Efficient Sampling.md', sections.map(([heading, text]) => '## '+heading+'\n'+text).join('\n'));
  const options = { mode: 'paper', source_ids: [article.id] };
  const request = data => call('/api/wiki/draft','POST',data);
  assert.equal((await request(options)).status,400);
  let payload, invalid = false;
  const mock = createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    payload = JSON.parse(raw);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'研究采样效率。',body:invalid?'结论。[99]':'## 方法\n作者采用重要性采样（importance sampling）。[1]'})}}]}));
  });
  await new Promise(resolve => mock.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => mock.close(resolve)));
  await call('/api/settings','PUT',{baseUrl:'http://127.0.0.1:'+mock.address().port+'/v1',model:'paper-mock'});
  assert.equal((await request({...options,source_ids:[article.id,'another-source']})).status,400);
  const proposal = await request(options);
  assert.equal(proposal.status,200,JSON.stringify(proposal.data));
  assert.equal(proposal.data.kind,'overview');
  assert.match(proposal.data.title,/Efficient Sampling/);
  assert.match(payload.messages[0].content,/区分作者结论与阅读解读/);
  const {evidence} = JSON.parse(payload.messages[1].content);
  assert.equal(evidence.length,32);
  assert.equal(proposal.data.coverage[0].total_chunks,48);
  for (const heading of ['Abstract','Methods','Experiments','Results','Limitations']) {
    const original = article.chunks.find(c => c.heading === heading);
    const cite = proposal.data.citations.find(c => c.chunk_id === original.id);
    assert.ok(cite,heading);
    assert.equal(evidence[cite.number-1].page, original.page);
    assert.equal(evidence[cite.number-1].content, original.content);
    assert.equal(cite.excerpt, original.content);
  }
  invalid = true;
  assert.equal((await request(options)).status,502);
  assert.equal((await call('/api/wiki')).data.length,0);
  const saved=await call('/api/wiki','POST',proposal.data);
  assert.equal(saved.status,201);
  assert.equal(saved.data.citations.length,32);
});
