import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { testServer } from './helpers.mjs';

async function fixture(t) {
  const server = await testServer(); t.after(() => server.close());
  const { request } = server;
  await request('/api/auth/setup', { method: 'POST', body: { password: 'library-batch-password' } });
  const upload = async title => {
    const form = new FormData(); form.append('files', new Blob([`# ${title}\nEvidence from ${title} explains a reproducible experiment and its limits.`]), title + '.md');
    const result = await request('/api/sources/upload', { method: 'POST', raw: form });
    assert.equal(result.status, 202);
    return (await request(`/api/sources/${result.data[0].id}`)).data;
  };
  const preview = ids => request('/api/sources/batch-delete/preview', { method: 'POST', body: { ids } });
  const execute = (ids, versions) => request('/api/sources/batch-delete', { method: 'POST', body: { ids, versions } });
  return { server, request, upload, preview, execute };
}

test('资料批量删除：预览、部分成功、引用保护、关联清理与重启持久化', async t => {
  const { server, request, upload, preview, execute } = await fixture(t);
  const a = await upload('可删除甲'), b = await upload('Wiki 证据'), c = await upload('论文档案'), d = await upload('可删除乙');
  const wiki = (await request('/api/wiki', { method: 'POST', body: { title: '保留的知识页', kind: 'concept', category: '个人学习', body: '原文证据。[1]', citations: [{ chunk_id: b.chunks[0].id }], related_ids: [] } })).data;
  const paper = (await request('/api/papers', { method: 'POST', body: { source_id: c.id, title: '保留的论文' } })).data;
  assert.ok(wiki.id); assert.ok(paper.id);
  const note = (await request('/api/notes', { method: 'POST', body: { title: '随资料删除', content: '实验笔记', source_id: a.id, chunk_id: a.chunks[0].id } })).data;
  const knowledge = (await request('/api/knowledge', { method: 'POST', body: { title: '保留知识点', source_id: a.id, chunk_id: a.chunks[0].id } })).data;
  const plan = (await request('/api/plans', { method: 'POST', body: { title: '保留计划', goal: '继续学习', source_id: a.id, steps: [] } })).data;
  const conversation = (await request('/api/conversations', { method: 'POST', body: { source_id: a.id } })).data;
  assert.ok(note.id); assert.ok(knowledge.id); assert.ok(plan.id); assert.ok(conversation.id);
  await request('/api/comments', { method: 'POST', body: { kind: 'source', target_id: a.id, content: '随资料删除的讨论' } });
  await request('/api/tasks', { method: 'POST', body: { kind: 'source', target_id: a.id, title: '随资料删除的任务' } });
  const ids = [a.id, b.id, c.id, d.id];
  const inspected = await preview(ids); assert.equal(inspected.status, 200);
  assert.equal(inspected.data.deletableCount, 2); assert.equal(inspected.data.blockedCount, 2);
  assert.equal(inspected.data.items.find(item => item.id === a.id).notes, 1);
  assert.match(inspected.data.items.find(item => item.id === b.id).reason, /Wiki/);
  assert.match(inspected.data.items.find(item => item.id === c.id).reason, /论文/);
  assert.equal((await request('/api/sources')).data.length, 4, '预览没有删除副作用');
  await access(join(server.dataDir, 'uploads', a.id));
  const versions = Object.fromEntries(inspected.data.items.map(item => [item.id, item._version]));
  const result = await execute(ids, versions); assert.equal(result.status, 200);
  assert.equal(result.data.deletedCount, 2); assert.equal(result.data.blockedCount, 2);
  assert.deepEqual(result.data.deleted.map(item => item.id).sort(), [a.id, d.id].sort());
  assert.deepEqual((await request('/api/sources')).data.map(item => item.id).sort(), [b.id, c.id].sort());
  await assert.rejects(access(join(server.dataDir, 'uploads', a.id)), { code: 'ENOENT' });
  const exported = (await request('/api/export')).data;
  assert.equal(exported.notes.length, 0); assert.equal(exported.comments.length, 0); assert.equal(exported.tasks.length, 0);
  assert.equal(exported.knowledge[0].source_id, null); assert.equal(exported.knowledge[0].chunk_id, null);
  assert.equal(exported.plans[0].source_id, null); assert.equal(exported.conversations[0].source_id, null);
  assert.equal((await request(`/api/wiki/${wiki.id}`)).data.citations[0].chunk_id, b.chunks[0].id);
  assert.equal((await request(`/api/papers/${paper.id}`)).status, 200);
  const db = new DatabaseSync(join(server.dataDir, 'knowledge.sqlite'));
  assert.equal(db.prepare("SELECT count(*) count FROM resource_versions WHERE target_id IN (?,?)").get(a.id, note.id).count, 0); db.close();
  await server.restart(); assert.equal((await request('/api/sources')).data.length, 2);
});

test('资料批量删除边界：无效输入不落库、版本与新引用重检、并发删除、只读权限', async t => {
  const { server, request, upload, preview, execute } = await fixture(t);
  const a = await upload('并发保护甲'), b = await upload('并发保护乙');
  for (const ids of [[], ['invalid'], [a.id, a.id], Array.from({ length: 101 }, () => randomUUID()), null, 'all'])
    assert.equal((await preview(ids)).status, 400);
  assert.equal((await execute([a.id], {})).status, 400);
  assert.equal((await execute([a.id, b.id], { [a.id]: 1, [b.id]: 1.5 })).status, 400);
  assert.equal((await request('/api/sources')).data.length, 2);
  const before = await preview([a.id, b.id]);
  const versions = Object.fromEntries(before.data.items.map(item => [item.id, item._version]));
  await request(`/api/sources/${a.id}`, { method: 'PATCH', body: { title: '其他成员刚刚编辑', _version: versions[a.id] } });
  const wiki = await request('/api/wiki', { method: 'POST', body: { title: '确认期间新增的引用', kind: 'concept', category: '个人学习', body: '证据。[1]', citations: [{ chunk_id: b.chunks[0].id }], related_ids: [] } });
  assert.equal(wiki.status, 201);
  const rejected = await execute([a.id, b.id], versions);
  assert.equal(rejected.data.deletedCount, 0); assert.equal(rejected.data.blockedCount, 2);
  assert.match(rejected.data.blocked.find(item => item.id === a.id).reason, /已被更新/);
  assert.match(rejected.data.blocked.find(item => item.id === b.id).reason, /Wiki/);
  const updated = (await preview([a.id])).data.items[0];
  const concurrent = await Promise.all([execute([a.id], { [a.id]: updated._version }), execute([a.id], { [a.id]: updated._version })]);
  assert.equal(concurrent.reduce((count, value) => count + value.data.deletedCount, 0), 1);
  const missing = (await preview([a.id])).data; assert.equal(missing.deletableCount, 0); assert.match(missing.items[0].reason, /不存在|删除/);
  const invitation = (await request('/api/team/invitations', { method: 'POST', body: { role: 'viewer' } })).data;
  const joined = await fetch(server.base + '/api/auth/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitation.token, username: 'batchviewer', name: '只读成员', password: 'viewer-batch-password' }) });
  const cookie = joined.headers.get('set-cookie').split(';')[0];
  for (const path of ['/api/sources/batch-delete/preview', '/api/sources/batch-delete']) {
    const response = await fetch(server.base + path, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [b.id], versions: { [b.id]: 1 } }) });
    assert.equal(response.status, 403);
  }
  const db = new DatabaseSync(join(server.dataDir, 'knowledge.sqlite'));
  db.prepare("UPDATE sources SET status='processing' WHERE id=?").run(b.id); db.close();
  assert.equal((await preview([b.id])).data.items[0].canDelete, false);
});
