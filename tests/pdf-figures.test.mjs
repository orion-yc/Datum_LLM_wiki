import test from 'node:test';
import assert from 'node:assert/strict';
import { testServer } from './helpers.mjs';
import { illustratedPdf } from './pdf-fixture.mjs';

test('既有 PDF 按页取回位图、矢量图和扫描页，并保留纯文字页的整页对照', async t => {
  const server = await testServer(); t.after(() => server.close());
  await server.request('/api/auth/setup', { method: 'POST', body: { password: 'figure-test-password' } });
  const form = new FormData(); form.append('files', new Blob([await illustratedPdf()]), 'illustrations.pdf');
  const upload = await server.request('/api/sources/upload', { method: 'POST', raw: form });
  assert.equal(upload.status, 202);
  const source = await server.ready(upload.data[0].id);
  assert.equal(source.pages, 4); assert.equal(source.status, 'ready');
  assert.equal(source.chunks.filter(c => c.page === 3).length, 0);
  const path = '/api/sources/' + source.id + '/pdf-figures/';
  await server.restart();
  async function jpeg(suffix) {
    const res = await fetch(server.base + path + suffix, { headers: { cookie: server.getCookie() } });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /^image\/jpeg/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.readUInt16BE(0), 0xffd8); return bytes;
  }
  for (const suffix of ['1', '1/original', '1/0']) assert.equal((await server.request(path + suffix, { auth: false })).status, 401);
  for (const suffix of ['0', '5', 'x', '1/9999', '5/original']) {
    const r = await server.request(path + suffix);
    assert.ok([400, 404].includes(r.status), suffix + ' ' + r.status);
  }
  for (const [page, expected] of [[1, 'figure'], [2, 'figure'], [3, 'page']]) {
    const r = await server.request(path + page);
    assert.equal(r.status, 200);
    const item = r.data.figures.find(f => f.kind === expected);
    assert.ok(item, JSON.stringify({ page, result: r.data }));
    const image = await jpeg(page + '/' + item.index);
    assert.deepEqual(await jpeg(page + '/' + item.index), image);
    if (expected === 'figure') assert.notDeepEqual(image, await jpeg(page + '/original'));
  }
  assert.deepEqual((await server.request(path + '4')).data.figures, []);
  assert.ok((await jpeg('4/original')).length > 100);
});
