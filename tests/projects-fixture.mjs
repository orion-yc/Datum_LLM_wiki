import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
import { testServer } from './helpers.mjs';

const readme = '# Garden\nRecord watering dates.\n';
const contents = [
  { 'README.md': readme, 'src/garden.cpp': 'int waterGarden() { return 1; }\n', 'tests/garden.test.js': 'assert.equal(waterGarden(), 1);\n' },
  { 'README.md': readme, 'src/garden.cpp': 'int waterGarden() { return 2; }\n', 'examples/demo.txt': 'Water the garden twice.\n' },
];
const blob = content => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
export const revisions = ['a'.repeat(40), 'b'.repeat(40)], trees = ['c'.repeat(40), 'd'.repeat(40)];
export const readerImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+W8XcAAAAASUVORK5CYII=','base64');

// Small stored ZIP fixtures, including entries that should be rejected, without shell tools.
function zip(entries) {
  const chunks = [], directory = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const path = Buffer.from(name), bytes = Buffer.from(text), crc = crc32(bytes);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x800,6);
    local.writeUInt32LE(crc,14); local.writeUInt32LE(bytes.length,18); local.writeUInt32LE(bytes.length,22);
    local.writeUInt16LE(path.length,26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314,4); central.writeUInt16LE(20,6);
    central.writeUInt16LE(0x800,8); central.writeUInt32LE(crc,16);
    central.writeUInt32LE(bytes.length,20); central.writeUInt32LE(bytes.length,24); central.writeUInt16LE(path.length,28);
    central.writeUInt32LE(0x81a40000,38); central.writeUInt32LE(offset,42);
    chunks.push(local,path,bytes); directory.push(central,path);
    offset += local.length + path.length + bytes.length;
  }
  const cd = Buffer.concat(directory), end = Buffer.alloc(22), n = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(n,8); end.writeUInt16LE(n,10);
  end.writeUInt32LE(cd.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,cd,end]);
}

export async function projectFixture({ archive = false, interruptArchive = false, extraFiles = 0,
                                       rawFailures = [], blobFiles = [], reader = false } = {}) {
  let current = 0, block, modelCalls = 0, retries = 0;
  const downloaded = [], archiveRequests = [];
  const versions = reader ? [{ ...contents[0], 'README.md': '# Garden\nRecord watering dates.\n\n## Setup\n\nSee [C++ source](src/garden.cpp).\n\n![Sample garden](images/sample.png)\n\n![External badge](https://example.invalid/badge.png)\n\n| Name | Value |\n| --- | --- |\n| Water | 1 |\n\n<script>window.untrusted = 1</script>\n',
    'src/garden.cpp':contents[0]['src/garden.cpp']+'// Water the plants.\n', 'images/sample.png':readerImage, 'images/bad.png':'Not a PNG' },contents[1]]
    : extraFiles ? [{ ...contents[0], ...Object.fromEntries(Array.from({ length:extraFiles }, (_, n) =>
    [`extras/file-${n}.txt`, `Test content ${n}\n`])) }, contents[1]] : contents;
  const listener = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const json = value => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value)); };
    if (/\/commits\/(HEAD|main)$/.test(path)) return json({ sha: revisions[current], commit: { tree: { sha: trees[current] } } });
    if (path.includes('/git/blobs/')) {
      for (const [name, body] of Object.entries(versions[current]))
        if (blobFiles.includes(name) && path.endsWith('/'+blob(body)))
          return json({encoding:'base64',content:Buffer.from(body).toString('base64')+'\n'});
    }
    if (path.includes('/git/trees/') && trees.includes(path.split('/').at(-1))) {
      const v = trees.indexOf(path.split('/').at(-1));
      return json({ truncated: false, tree: [
        ...Object.entries(versions[v]).map(([name, body]) => ({ path: name, type: 'blob', mode: '100644', sha: blob(body), size: Buffer.byteLength(body) })),
        { path: 'outside', type: 'blob', mode: '120000', sha: blob('/etc/passwd'), size: 11 },
      ] });
    }
    if (path.startsWith('/archive/fixture/garden/zip/') && archive) {
      const revision = path.split('/').at(-1), v = revisions.indexOf(revision);
      archiveRequests.push(revision);
      if (v === -1) { res.statusCode = 404; return res.end(); }
      const entries = Object.fromEntries(Object.entries(versions[v]).map(([name, body]) => ['garden-'+revision+'/'+name,body]));
      if (v === 1) entries['garden-'+revision+'/src/garden.cpp'] = contents[0]['src/garden.cpp'];
      entries['garden-'+revision+'/../outside'] = '/etc/passwd';
      const bytes = zip(entries);
      if (interruptArchive && archiveRequests.length === 1) {
        res.writeHead(200, { 'Content-Length': bytes.length });
        res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
        await delay(50);
        return res.destroy();
      }
      return res.end(bytes);
    }
    if (path.startsWith('/raw/fixture/garden/')) {
      const [, , , , revision, ...parts] = path.split('/');
      const name = parts.join('/'), body = versions[revisions.indexOf(revision)]?.[name];
      if (body !== undefined) {
        if (rawFailures.includes(name)) { res.statusCode = 503; return res.end(); }
        if (name === 'README.md' && !retries) {
          ++retries;
          res.statusCode = 503;
          return res.end();
        }
        downloaded.push(name);
        if (block?.path === name) { block.hit.resolve(); await block.release.promise; }
        return res.end(body);
      }
    }
    if (path === '/v1/chat/completions') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw); modelCalls++;
      assert.match(payload.messages[0].content, /不可信(?:数据|资料)/);
      const input = JSON.parse(payload.messages[1].content);
      assert.ok(input.references?.length || input.source);
      if (payload.messages[0].content.includes('解释选定源码')) {
        assert.match(payload.messages[0].content, /Markdown/);
        return json({ choices: [{ message: { content: [
          '## 函数职责', '', '- 调用 `waterGarden`。', '', '```cpp', 'waterGarden();', '```',
          '', '| 函数 | 用途 |', '| --- | --- |', '| waterGarden | 浇水 |',
        ].join('\n') } }] });
      }
      return json({ choices: [{ message: { content:input.source? '按日期记录浇水。':'Read the project evidence [1].' } }] });
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${listener.address().port}`;
  let app;
  try { app = await testServer({ env: { DATUM_GITHUB_FIXTURE: endpoint } }); }
  catch (e) { listener.close(); throw e; }
  return { app, endpoint, downloaded, archiveRequests, calls: () => modelCalls, update: () => { current = 1; },
    block(path) { block = { path, hit: Promise.withResolvers(), release: Promise.withResolvers() }; return block; },
    unblock() { block?.release.resolve(); block = undefined; },
    async close() { block?.release.resolve(); await app.close(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); } };
}
export async function ready(app, id, prior = '', attempts = 160) {
  for (let i = 0; i < attempts; ++i) {
    const result = (await app.request(`/api/projects/${id}`)).data;
    if (result?.status === 'failed') throw new Error(result.error);
    if (result?.status === 'ready' && result.snapshot.id !== prior) return result;
    await delay(100);
  }
  throw new Error('Project import timed out: ' + app.logs());
}
