import test from 'node:test';
import assert from 'node:assert/strict';
import { testServer } from './helpers.mjs';
import { createServer } from 'node:http';

function client(base) {
  let cookie = '';
  return async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: response.status, data };
  };
}
async function teamFixture(t) {
  const server = await testServer(); t.after(() => server.close());
  const owner = client(server.base), editor = client(server.base), reviewer = client(server.base), viewer = client(server.base), admin = client(server.base);
  assert.equal((await owner('/api/auth/setup', 'POST', { username: 'owner', name: '所有者', teamName: '研究小组', password: 'owner-password' })).status, 201);
  async function join(agent, username, role) {
    const invite = await owner('/api/team/invitations', 'POST', { role }); assert.equal(invite.status, 201);
    assert.equal((await agent('/api/auth/join', 'POST', { token: invite.data.token, username, name: username, password: username + '-password' })).status, 201);
    return (await agent('/api/auth')).data.user;
  }
  const editorUser = await join(editor, 'editor', 'editor'), reviewerUser = await join(reviewer, 'reviewer', 'editor'), viewerUser = await join(viewer, 'viewer', 'viewer'), adminUser = await join(admin, 'admin2', 'admin');
  return { server, owner, editor, reviewer, viewer, admin, editorUser, reviewerUser, viewerUser, adminUser };
}
async function upload(agent, title, content) {
  const form = new FormData(); form.append('category', '论文研究'); form.append('files', new Blob([content]), `${title}.md`);
  const result = await agent('/api/sources/upload', 'POST', form); assert.equal(result.status, 202, JSON.stringify(result.data));
  const source = (await agent(`/api/sources/${result.data[0].id}`)).data; assert.equal(source.status, 'ready'); return source;
}

test('论文模型生成：逐篇归纳、上游失败不落库、并发修改不会被慢模型覆盖', async t => {
  const { owner, editor, reviewer } = await teamFixture(t);
  let fail = false, block = false, release, arrived;
  let gate = Promise.resolve();
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    assert.equal(body.reasoning_effort, 'medium'); assert.equal(Object.hasOwn(body, 'temperature'), false);
    if (block) { block = false; arrived(); await gate; }
    if (fail) { res.writeHead(401); res.end('{}'); return; }
    const payload = JSON.parse(body.messages[1].content);
    const content = JSON.stringify(payload.dimensions_with_evidence.map(cell => ({ dimension: cell.dimension, content: '依据所附原文归纳，实验设置需要人工核对。' })));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => mock.close(r)));
  const paperIds = [];
  for (const name of ['模型论文甲', '模型论文乙']) { const source = await upload(editor, name, `# ${name}\n使用有序索引验证检索方法。\n## 指标\n记录实验环境与误差区间。`); paperIds.push((await editor('/api/papers', 'POST', { source_id: source.id, title: name })).data.id); }
  let comparison = (await editor('/api/comparisons', 'POST', { title: '模型证据归纳', question: '如何比较实验设置', paper_ids: paperIds, dimensions: ['方法', '指标'], cells: [], conclusion: '初始结论' })).data;
  assert.equal((await owner('/api/settings', 'PUT', { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'paper-mock', reasoningEffort: 'medium' })).status, 200);
  comparison = (await editor(`/api/comparisons/${comparison.id}/generate`, 'POST', { _version: comparison._version })).data;
  assert.equal(comparison.generation_mode, 'model'); assert.ok(comparison.cells.every(cell => cell.content.includes('依据所附原文') && cell.citations.length));
  const previousVersion = comparison._version; fail = true;
  assert.equal((await editor(`/api/comparisons/${comparison.id}/generate`, 'POST', { _version: previousVersion })).status, 502);
  assert.equal((await editor(`/api/comparisons/${comparison.id}`)).data._version, previousVersion);
  fail = false; block = true; gate = new Promise(r => { release = r; }); const started = new Promise(r => { arrived = r; });
  const pending = editor(`/api/comparisons/${comparison.id}/generate`, 'POST', { _version: previousVersion }); await started;
  assert.equal((await reviewer(`/api/comparisons/${comparison.id}`, 'PUT', { ...comparison, conclusion: '模型等待期间由同事保存的结论' })).status, 200);
  release(); assert.equal((await pending).status, 409);
  assert.equal((await owner(`/api/comparisons/${comparison.id}`)).data.conclusion, '模型等待期间由同事保存的结论');
});

test('成员权限：邀请单次使用与撤销、角色边界、重置密码、停用和所有权转移', async t => {
  const { server, owner, editor, viewer, admin, editorUser, viewerUser, adminUser } = await teamFixture(t);
  assert.equal((await editor('/api/team/invitations', 'POST', { role: 'admin' })).status, 403);
  assert.equal((await admin('/api/team/invitations', 'POST', { role: 'admin' })).status, 400);
  assert.equal((await admin(`/api/team/members/${adminUser.id}`, 'PATCH', { role: 'editor' })).status, 403);
  const ownerUser = (await owner('/api/auth')).data.user;
  assert.equal((await admin(`/api/team/members/${ownerUser.id}`, 'PATCH', { active: false })).status, 403);
  assert.equal((await viewer('/api/sources/sample', 'POST')).status, 403);
  assert.equal((await viewer('/api/settings', 'PUT', { baseUrl: '', model: '', reasoningEffort: 'high' })).status, 403);
  assert.equal((await editor('/api/settings', 'PUT', { baseUrl: '', model: '', reasoningEffort: 'high' })).status, 403);
  assert.equal((await viewer('/api/export')).status, 403);
  assert.equal((await viewer('/api/team/profile', 'PUT', { name: '只读研究员' })).status, 200);
  assert.ok(!(JSON.stringify((await viewer('/api/team')).data).includes('password')));
  const invite = (await owner('/api/team/invitations', 'POST', { role: 'editor' })).data;
  const fresh = client(server.base);
  assert.equal((await fresh(`/api/auth/invitation?token=${invite.token}`)).status, 200);
  assert.equal((await fresh('/api/auth/join', 'POST', { token: invite.token, username: 'joined', name: '新成员', password: 'joined-password' })).status, 201);
  assert.equal((await fresh('/api/auth/join', 'POST', { token: invite.token, username: 'again', name: '重复', password: 'again-password' })).status, 409);
  const revoked = (await owner('/api/team/invitations', 'POST', { role: 'viewer' })).data;
  await owner(`/api/team/invitations/${revoked.id}`, 'DELETE');
  assert.equal((await fresh(`/api/auth/invitation?token=${revoked.token}`)).status, 404);
  assert.equal((await owner(`/api/team/members/${editorUser.id}/password`, 'POST', { password: 'reset-editor-password' })).status, 200);
  assert.equal((await editor('/api/sources')).status, 401);
  assert.equal((await editor('/api/auth/login', 'POST', { username: 'editor', password: 'editor-password' })).status, 401);
  assert.equal((await editor('/api/auth/login', 'POST', { username: 'editor', password: 'reset-editor-password' })).status, 200);
  await owner(`/api/team/members/${viewerUser.id}`, 'PATCH', { active: false });
  assert.equal((await viewer('/api/sources')).status, 401);
  assert.equal((await viewer('/api/auth/login', 'POST', { username: 'viewer', password: 'viewer-password' })).status, 401);
  assert.equal((await owner('/api/team/owner', 'POST', { user_id: adminUser.id, password: 'owner-password' })).status, 200);
  assert.equal((await admin('/api/auth')).data.user.role, 'owner');
  assert.equal((await owner('/api/auth')).data.user.role, 'admin');
});

test('多成员协作：评论归属、共享任务、责任人权限与并发编辑冲突', async t => {
  const { owner, editor, reviewer, viewer, editorUser, reviewerUser, viewerUser } = await teamFixture(t);
  const source = await upload(editor, '协作资料', '# 方法\n用实验验证假设，并记录数据来源和误差。');
  assert.equal((await viewer(`/api/sources/${source.id}`)).status, 200);
  const note = (await editor('/api/notes', 'POST', { title: '实验备注', content: '初稿', source_id: source.id })).data;
  const concurrent = await Promise.all([editor(`/api/notes/${note.id}`, 'PUT', { ...note, content: '编辑者修改' }), reviewer(`/api/notes/${note.id}`, 'PUT', { ...note, content: '审核者修改' })]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  const comment = (await editor('/api/comments', 'POST', { kind: 'source', target_id: source.id, content: '需要补充实验环境' })).data;
  assert.equal((await reviewer(`/api/comments/${comment.id}`, 'PATCH', { resolved: true })).status, 403);
  assert.equal((await viewer('/api/comments', 'POST', { kind: 'source', target_id: source.id, content: '越权' })).status, 403);
  assert.equal((await owner(`/api/comments/${comment.id}`, 'PATCH', { resolved: true })).status, 200);
  assert.equal((await viewer(`/api/comments?kind=source&target=${source.id}`)).data[0].resolved, 1);
  assert.equal((await editor('/api/tasks', 'POST', { kind: 'source', target_id: source.id, title: '不合法任务', description: '', assignee_id: viewerUser.id })).status, 400);
  const task = (await editor('/api/tasks', 'POST', { kind: 'source', target_id: source.id, title: '补齐实验环境', description: '核对硬件与运行参数', assignee_id: reviewerUser.id, due_date: '2026-12-01' })).data;
  assert.equal((await reviewer(`/api/tasks/${task.id}`, 'PATCH', { status: 'doing', _version: task._version })).status, 200);
  assert.equal((await editor(`/api/tasks/${task.id}`, 'PATCH', { status: 'done', _version: task._version })).status, 409);
  assert.equal((await reviewer(`/api/tasks/${task.id}`, 'DELETE')).status, 403);
  assert.equal((await viewer(`/api/tasks/${task.id}`, 'PATCH', { status: 'done' })).status, 403);
  const latest = (await owner('/api/tasks')).data.find(t => t.id === task.id); assert.equal(latest._version, 2); assert.equal(latest.assignee_name, 'reviewer');
  assert.equal((await reviewer(`/api/tasks/${task.id}`, 'PATCH', { status: 'done', _version: latest._version })).status, 200);
  const activities = (await owner('/api/dashboard')).data.activities; assert.ok(activities.some(a => a.actor_id === editorUser.id));
});

test('论文工作流：元信息、真实引用矩阵、生成、审核发布、版本恢复、导出和重启', async t => {
  const { server, owner, editor, reviewer, viewer, reviewerUser } = await teamFixture(t);
  const a = await upload(editor, '论文甲', '# 核心方法\n方法甲使用有序索引进行查找。\n## 评价指标\n实验 A 延迟为 10 ms，数据集是集合 A。');
  const b = await upload(editor, '论文乙', '# 核心方法\n方法乙使用哈希映射。\n## 评价指标\n实验 B 延迟为 12 ms，数据集是集合 B。不同实验设置不能直接比较数值。');
  const paperA = (await editor('/api/papers', 'POST', { source_id: a.id, title: '论文甲', authors: '作者甲', year: 2025, venue: '研究会议', method: '有序索引' })).data;
  const paperB = (await editor('/api/papers', 'POST', { source_id: b.id, title: '论文乙', authors: '作者乙', year: 2026 })).data;
  assert.equal((await editor('/api/papers', 'POST', { source_id: a.id, title: '重复档案' })).status, 409);
  assert.equal((await editor(`/api/sources/${a.id}`, 'DELETE')).status, 409);
  assert.equal((await viewer('/api/papers')).data.length, 2);
  const create = await editor('/api/comparisons', 'POST', { title: '索引方法对比', question: '不同数据设置下的查找方法适用性', paper_ids: [paperA.id, paperB.id], dimensions: ['核心方法', '评价指标'], cells: [], conclusion: '实验设置不同，需要重新验证。', reviewer_id: reviewerUser.id });
  assert.equal(create.status, 201, JSON.stringify(create.data)); let comparison = create.data;
  assert.equal((await reviewer(`/api/comparisons/${comparison.id}/status`, 'POST', { status: 'published', _version: comparison._version })).status, 409);
  const forged = { ...comparison, cells: comparison.cells.map((cell, i) => i ? cell : { ...cell, content: '伪造证据', citations: [{ chunk_id: b.chunks[0].id, excerpt: '伪造引文' }] }) };
  assert.equal((await editor(`/api/comparisons/${comparison.id}`, 'PUT', forged)).status, 400);
  const generated = await editor(`/api/comparisons/${comparison.id}/generate`, 'POST', { _version: comparison._version }); assert.equal(generated.status, 200); comparison = generated.data; assert.equal(comparison.generation_mode, 'extract'); assert.ok(comparison.cells.every(cell => cell.citations.length));
  const stale = { ...comparison }; comparison.cells[0].citations[0].excerpt = '攻击者提交的伪造引文';
  comparison = (await editor(`/api/comparisons/${comparison.id}`, 'PUT', comparison)).data;
  assert.ok(!JSON.stringify(comparison).includes('攻击者提交的伪造引文'));
  assert.equal((await reviewer(`/api/comparisons/${comparison.id}`, 'PUT', stale)).status, 409);
  assert.equal((await viewer(`/api/comparisons/${comparison.id}`, 'PUT', comparison)).status, 403);
  const comment = (await reviewer('/api/comments', 'POST', { kind: 'comparison', target_id: comparison.id, content: '核对两种设置是否一致。' })).data;
  comparison = (await editor(`/api/comparisons/${comparison.id}/status`, 'POST', { status: 'review', _version: comparison._version })).data;
  assert.equal((await editor(`/api/comparisons/${comparison.id}`, 'PUT', comparison)).status, 409);
  assert.equal((await editor(`/api/comparisons/${comparison.id}/status`, 'POST', { status: 'published', _version: comparison._version })).status, 403);
  assert.equal((await reviewer(`/api/comparisons/${comparison.id}/status`, 'POST', { status: 'published', _version: comparison._version })).status, 409);
  await reviewer(`/api/comments/${comment.id}`, 'PATCH', { resolved: true });
  comparison = (await reviewer(`/api/comparisons/${comparison.id}/status`, 'POST', { status: 'published', _version: comparison._version })).data; assert.equal(comparison.status, 'published');
  assert.equal((await editor(`/api/comparisons/${comparison.id}/status`, 'POST', { status: 'draft', _version: comparison._version })).status, 403);
  assert.equal((await editor(`/api/papers/${paperA.id}`, 'DELETE')).status, 409);
  const report = await viewer(`/api/comparisons/${comparison.id}/export`); assert.equal(report.status, 200); assert.match(report.data, /原文证据/); assert.match(report.data, /10 ms/); assert.match(report.data, /参考文献/);
  const history = (await owner(`/api/comparisons/${comparison.id}/history`)).data; assert.ok(history.length >= 5); assert.ok(history.every(h => h.snapshot && h.author_name));
  comparison = (await owner(`/api/comparisons/${comparison.id}/restore`, 'POST', { _version: comparison._version, history_id: history.at(-1).id })).data; assert.equal(comparison.status, 'draft'); assert.ok(comparison.cells.every(cell => !cell.content));
  assert.ok((await owner('/api/export')).data.comparison_history.length >= 6);
  await server.restart();
  assert.equal((await viewer('/api/auth')).data.user.role, 'viewer');
  assert.equal((await owner(`/api/comparisons/${comparison.id}`)).data._version, comparison._version);
  assert.equal((await owner(`/api/papers/${paperA.id}`)).data.authors, '作者甲');
});
