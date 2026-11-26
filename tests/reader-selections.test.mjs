import test from 'node:test';
import assert from 'node:assert/strict';
import { testServer } from './helpers.mjs';

test('正文摘录随笔记和关联保存，知识点合并、解除关联和旧版笔记兼容', async t => {
  const server = await testServer();
  t.after(() => server.close());
  const call = (path, method, body) => server.request(path, { method, body });
  await call('/api/auth/setup', 'POST', { password: 'selection-test-password' });
  const sample = (await call('/api/sources/sample', 'POST')).data;
  const source = await server.ready(sample.id), chunk = source.chunks[1];
  const selection = { chunk_id: chunk.id, end_chunk_id: chunk.id, start_offset: 2, end_offset: 8, quote: chunk.content.slice(2, 8) };
  const sourcePath = '/api/sources/' + source.id, links = sourcePath + '/knowledge-links';
  const noteData = { title: '阅读记录', content: '需要复习', source_id: source.id, chunk_id: chunk.id };
  const note = await call('/api/notes', 'POST', { ...noteData, selection });
  assert.equal(note.status, 201); assert.deepEqual(note.data.selection, selection);
  const changed = await call('/api/notes/' + note.data.id, 'PUT', { ...noteData, content: '已经复习' });
  assert.deepEqual(changed.data.selection, selection);
  const legacy = await call('/api/notes', 'POST', noteData);
  assert.equal(legacy.data.selection, null);

  const target = { title: '知识点', summary: '根据原文练习' };
  const upload = new FormData();
  upload.append('files', new Blob(['# 其他资料\n这段原文属于另一份独立的资料。']), 'other.md');
  const other = await server.ready((await server.request('/api/sources/upload', { method: 'POST', raw: upload })).data[0].id);
  for (const invalid of [{ ...selection, start_offset: -1 }, { ...selection, end_offset: 20000 },
    { ...selection, start_offset: selection.end_offset }, { ...selection, quote: ' ' },
    { ...selection, end_chunk_id: other.chunks[0].id },
    { ...selection, end_chunk_id: source.chunks[0].id }]) {
    assert.equal((await call(links, 'POST', { selection: invalid, new_knowledge: target })).status, 400);
  }
  assert.deepEqual((await call('/api/knowledge', 'GET')).data, []);
  const linked = await call(links, 'POST', { selection, new_knowledge: target });
  assert.equal(linked.status, 201); assert.deepEqual(linked.data.selection, selection);
  const knowledge = linked.data.knowledge_id;
  const backlinks = await call('/api/knowledge/' + knowledge + '/source-links', 'GET');
  assert.equal(backlinks.status, 200); assert.equal(backlinks.data[0].source_title, source.title);
  assert.equal(backlinks.data[0].page, chunk.page); assert.deepEqual(backlinks.data[0].selection, selection);
  const repeat = await call(links, 'POST', { knowledge_id: knowledge, selection });
  assert.equal(repeat.status, 200); assert.equal(repeat.data.id, linked.data.id);
  const merged = await call('/api/knowledge', 'POST', { ...target, title: '合并后的知识点' });
  const end = source.chunks[2];
  const cross = { ...selection, end_chunk_id: end.id, quote: chunk.content.slice(2) + end.content.slice(0, 8) };
  assert.equal((await call(links, 'POST', { knowledge_id: knowledge, selection: cross })).status, 201);
  assert.equal((await call(links, 'POST', { knowledge_id: merged.data.id, selection })).status, 201);
  assert.equal((await call('/api/knowledge/' + merged.data.id + '/merge', 'POST', { from_id: knowledge })).status, 200);
  await server.restart();
  const detail = (await call(sourcePath, 'GET')).data;
  assert.equal(detail.knowledge_links.length, 2);
  assert.ok(detail.knowledge_links.every(l => l.knowledge_id === merged.data.id));
  assert.ok(detail.notes.some(n => n.selection?.quote === selection.quote));
  const exported = (await call('/api/export', 'GET')).data;
  assert.ok(exported.source_knowledge_links.some(l => l.selection.quote === cross.quote));
  assert.equal((await call('/api/sources/' + crypto.randomUUID() + '/knowledge-links/' + detail.knowledge_links[0].id, 'DELETE')).status, 404);
  assert.equal((await call(links + '/' + detail.knowledge_links[0].id, 'DELETE')).status, 200);
  assert.equal((await call(sourcePath, 'GET')).data.knowledge_links.length, 1);
  assert.equal((await call('/api/knowledge/' + merged.data.id, 'DELETE')).status, 200);
  assert.deepEqual((await call(sourcePath, 'GET')).data.knowledge_links, []);
  const keep = await call(links, 'POST', { selection, new_knowledge: target });
  assert.equal((await call(sourcePath, 'DELETE')).status, 200);
  assert.deepEqual((await call('/api/knowledge/' + keep.data.knowledge_id + '/source-links', 'GET')).data, []);
});
