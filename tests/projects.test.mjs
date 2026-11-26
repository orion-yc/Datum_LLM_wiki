import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { projectFixture, ready, revisions } from './projects-fixture.mjs';

test('备用 Git blob 下载，保留待补齐文件与已有学习进度', async t => {
  const rawFailures = ['README.md','src/garden.cpp'];
  const f = await projectFixture({ rawFailures, blobFiles:['README.md'] }), { app } = f;
  t.after(() => f.close());
  await app.request('/api/auth/setup',{method:'POST',body:{password:'retry-project-files-password'}});
  const created = await app.request('/api/projects',{method:'POST',body:{url:'https://github.com/fixture/garden'}});
  const root = '/api/projects/'+created.data.id;
  const first = await ready(app,created.data.id);
  assert.deepEqual(first.counts,{total:4,indexed:2,skipped:1,unavailable:1});
  assert.match((await app.request(root+'/file?path=README.md')).data.lines[0], /Garden/);
  assert.equal((await app.request(root+'/progress',{method:'POST',body:{step:'文档',stage:'read'}})).status,200);
  rawFailures.length = 0;
  assert.equal((await app.request(root+'/sync',{method:'POST',body:{action:'retry-files'}})).status,200);
  const after = await ready(app,created.data.id);
  assert.equal(after.snapshot.id,first.snapshot.id);
  assert.deepEqual(after.counts,{total:4,indexed:3,skipped:1});
  assert.equal(after.progress[0].stage,'read');
  assert.deepEqual(f.downloaded,['tests/garden.test.js','src/garden.cpp']);
});

test('一次导入大于 5,000 个文件的整个仓库', {timeout:60000}, async t => {
  const f = await projectFixture({ archive:true, extraFiles:5100 }), { app } = f;
  t.after(() => f.close());
  await app.request('/api/auth/setup', { method:'POST', body:{ password:'large-project-password' } });
  const created = await app.request('/api/projects', { method:'POST', body:{ url:'https://github.com/fixture/garden' } });
  assert.equal(created.status, 202);
  const project = await ready(app, created.data.id, '', 400);
  assert.deepEqual(project.counts, { total:5104, indexed:5103, skipped:1 });
  assert.deepEqual(f.archiveRequests, [revisions[0]]);
  assert.deepEqual(f.downloaded, []);
  const p = '/api/projects/'+created.data.id;
  assert.deepEqual((await app.request(p+'/files?offset=5100')).data.total, 5104);
  assert.match((await app.request(p+'/file?path=extras%2Ffile-5000.txt')).data.lines[0], /5000/);
});

test('删除正在导入的项目并取消后台任务，且允许再次导入同一链接', async t => {
  const f = await projectFixture(), { app } = f;
  t.after(() => f.close());
  await app.request('/api/auth/setup', { method:'POST', body:{ password:'delete-project-password' } });
  const body = { url:'https://github.com/fixture/garden' }, hold = f.block('src/garden.cpp');
  const first = await app.request('/api/projects', { method:'POST', body });
  await Promise.race([hold.hit.promise, delay(5000).then(() => { throw Error('Expected blocked download'); })]);
  const p = '/api/projects/'+first.data.id;
  assert.equal((await app.request(p, { method:'DELETE' })).status, 200);
  f.unblock();
  assert.equal((await app.request(p)).status, 404);
  const again = await app.request('/api/projects', { method:'POST', body });
  assert.equal(again.status, 202);
  assert.notEqual(again.data.id, first.data.id);
  assert.equal((await ready(app, again.data.id)).counts.indexed, 3);
});

test('项目优先读取固定提交 ZIP，一次获取、校验并只补下载不匹配的文件', async t => {
  const f = await projectFixture({ archive: true }), { app } = f;
  t.after(() => f.close());
  await app.request('/api/auth/setup', { method: 'POST', body: { password: 'archive-test-password' } });
  const create = await app.request('/api/projects', { method: 'POST', body: { url: 'https://github.com/fixture/garden' } });
  assert.equal(create.status, 202);
  const base = '/api/projects/' + create.data.id;
  const first = await ready(app, create.data.id);
  assert.deepEqual(f.archiveRequests, [revisions[0]]);
  assert.deepEqual(f.downloaded, []);
  assert.deepEqual(first.counts, { total: 4, indexed: 3, skipped: 1 });
  const files = (await app.request(base+'/files')).data.files;
  assert.equal(files.find(row => row.path === 'outside').status, 'skipped');

  f.update();
  await app.request(base+'/sync', { method: 'POST' });
  await ready(app, create.data.id, first.snapshot.id);
  assert.deepEqual(f.archiveRequests, revisions);
  assert.deepEqual(f.downloaded, ['src/garden.cpp']);
  assert.match((await app.request(base+'/file?path=src%2Fgarden.cpp')).data.lines[0], /return 2/);
  assert.match((await app.request(base+'/file?path=examples%2Fdemo.txt')).data.lines[0], /twice/);
  assert.equal((await app.request(base+'/file?path=outside')).status, 404);
});

test('归档传输中断时重新下载 ZIP，不回退为逐文件请求', async t => {
  const f = await projectFixture({ archive: true, interruptArchive: true }), { app } = f;
  t.after(() => f.close());
  await app.request('/api/auth/setup', { method:'POST', body:{ password:'archive-interruption-password' } });
  const created = await app.request('/api/projects', { method:'POST', body:{ url:'https://github.com/fixture/garden' } });
  assert.equal(created.status, 202);
  assert.equal((await ready(app, created.data.id)).counts.indexed, 3);
  assert.deepEqual(f.archiveRequests, [revisions[0], revisions[0]]);
  assert.deepEqual(f.downloaded, []);
});

test('项目导入、暂停跨重启、引用、学习进度和增量版本', { timeout: 60000 }, async t => {
  const f = await projectFixture(), { app } = f;
  t.after(() => f.close());
  await app.request('/api/auth/setup', { method: 'POST', body: { password: 'project-test-password' } });
  assert.equal((await app.request('/api/projects', { auth: false })).status, 401);
  for (const url of ['https://github.com.attacker.test/a/b', 'https://user@github.com/a/b', 'https://github.com/a/b/tree/main/../private', 'http://github.com/a/b'])
    assert.equal((await app.request('/api/projects', { method: 'POST', body: { url } })).status, 400, url);
  const hold = f.block('src/garden.cpp');
  const create = await app.request('/api/projects', { method: 'POST', body: { url: 'https://github.com/Fixture/Garden/', goal: 'architecture' } });
  assert.equal(create.status, 202, JSON.stringify(create.data));
  const id = create.data.id, base = `/api/projects/${id}`;
  await Promise.race([hold.hit.promise, delay(5000).then(() => { throw Error('Expected blocked download'); })]);
  assert.equal((await app.request(base + '/sync', { method: 'POST', body: { action: 'pause' } })).data.status, 'paused');
  f.unblock();
  await app.restart();
  assert.equal((await app.request(base)).data.status, 'paused');
  await app.request(base + '/sync', { method: 'POST' });
  const first = await ready(app,id);
  assert.deepEqual(first.counts, { total: 4, indexed: 3, skipped: 1 });
  assert.equal(f.downloaded.filter(path => path === 'README.md').length, 1);
  assert.equal(first.snapshot.revision,revisions[0]);
  assert.ok(first.route.some(step => step.id === '源码'));
  assert.equal(f.calls(),0);
  assert.equal((await app.request('/api/projects',{method:'POST',body:{url:'https://github.com/fixture/garden'}})).data.id,id);
  const files = (await app.request(base+'/files')).data;
  assert.equal(files.files.find(row => row.path === 'outside').status,'skipped');
  const file = (await app.request(base+'/file?path=src%2Fgarden.cpp')).data;
  assert.match(file.url,new RegExp(revisions[0]+'/src/garden.cpp#L1'));
  assert.match(file.lines[0],/return 1/);
  const result = await app.request(base+'/ask',{method:'POST',body:{question:'waterGarden',scope:'src/'}});
  assert.equal(result.data.mode,'extract');
  assert.deepEqual(result.data.references.map(ref => ref.path),['src/garden.cpp']);
  await app.request('/api/settings',{method:'PUT',body:{model:'local-mock',baseUrl:f.endpoint+'/v1'}});
  const generated = await app.request(base+'/guide',{method:'POST'});
  assert.equal(generated.data.mode,'model');
  assert.equal((await app.request(base)).data.guide_refs.length,generated.data.references.length);
  assert.equal(f.calls(),1);
  const knowledge = await app.request('/api/knowledge',{method:'POST',body:{title:'养护记录',summary:'追踪养护频率',prerequisites:[],tags:[]}});
  const link = { path:'src/garden.cpp',first:1,last:1,targetType:'knowledge',target:knowledge.data.id,relation:'实现' };
  assert.equal((await app.request(base+'/links',{method:'POST',body:{...link,last:999}})).status,400);
  assert.equal((await app.request(base+'/links',{method:'POST',body:link})).status,201);
  const backlinks = (await app.request('/api/projects/related?type=knowledge&id='+knowledge.data.id)).data;
  assert.equal(backlinks[0].snapshot_id,first.snapshot.id);
  await app.request(base+'/progress',{method:'POST',body:{step:'文档',stage:'understood',note:'记录读过的入口'}});
  f.update();
  await app.request(base+'/sync',{method:'POST'});
  const second = await ready(app,id,first.snapshot.id);
  assert.deepEqual(second.changes,{added:1,modified:1,removed:1});
  assert.equal(f.downloaded.filter(path => path === 'README.md').length,1);
  assert.equal(second.progress[0].note,'记录读过的入口');
  assert.match((await app.request(base+'/file?path=src%2Fgarden.cpp&snapshot='+first.snapshot.id)).data.lines[0],/return 1/);
  assert.match((await app.request(base+'/file?path=src%2Fgarden.cpp')).data.lines[0],/return 2/);
  const scoped = await app.request('/api/projects',{method:'POST',body:{url:'https://github.com/fixture/garden/tree/main/src'}});
  assert.equal((await ready(app,scoped.data.id)).scope,'src');
  assert.equal((await app.request('/api/projects/'+scoped.data.id+'/files')).data.total,1);
  const invite = await app.request('/api/team/invitations',{method:'POST',body:{role:'viewer'}});
  await app.request('/api/auth/join',{method:'POST',auth:false,body:{token:invite.data.token,username:'reader',name:'Reader',password:'reader-password'}});
  assert.equal((await app.request(base)).status,200);
  assert.equal((await app.request(base+'/sync',{method:'POST'})).status,403);
  assert.equal((await app.request(base,{method:'DELETE'})).status,403);
  await app.request('/api/auth/login',{method:'POST',auth:false,body:{username:'admin',password:'project-test-password'}});
  assert.equal((await app.request(base,{method:'DELETE'})).status,200);
  assert.equal((await app.request(base)).status,404);
  assert.deepEqual((await app.request('/api/projects/related?type=knowledge&id='+knowledge.data.id)).data,[]);
  assert.ok((await app.request('/api/knowledge')).data.some(k => k.id === knowledge.data.id));
  assert.match((await app.request('/api/projects/'+scoped.data.id+'/file?path=src%2Fgarden.cpp')).data.lines[0],/return 2/);
  const db = new DatabaseSync(join(app.dataDir,'knowledge.sqlite'), { readOnly:true });
  try {
    for (const table of ['project_links','project_progress','project_guides'])
      assert.equal(db.prepare('SELECT count(*) AS n FROM '+table).get().n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM project_blobs').get().n,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally { db.close(); }
});
