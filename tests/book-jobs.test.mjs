import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {testServer} from './helpers.mjs';

async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(80);
  }
  assert.fail('等待超时：' + label);
}

async function fixture(t, pages, chapterStarts) {
  const app = await testServer();
  const modelCalls = [];
  let gate = Promise.withResolvers();
  let rejectModel = false;
  let blockedCall = 1;
  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(JSON.parse(raw).messages.at(-1).content);
    modelCalls.push(input);
    if (gate && modelCalls.length === blockedCall) await gate.promise;
    if (rejectModel) { res.writeHead(503); res.end('{}'); return; }
    const content = {notes:'已读前一批原文。', summary:'章节导读', body:'本章解释原理和例题。[1]', links:[]};
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]}));
  });
  await new Promise(resolve => model.listen(0,'127.0.0.1',resolve));
  t.after(async () => {
    gate?.resolve();
    await app.close();
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
  });

  await app.request('/api/auth/setup',{method:'POST',body:{password:'test-book-worker-password'}});
  await app.request('/api/settings',{method:'PUT',body:{model:'book-mock',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1'}});
  const form = new FormData();
  const markdown = Array.from({length:pages}, (_,i) => '## 原文第 '+(i+1)+' 节\n原理与例子 '+(i+1)+'。').join('\n');
  form.append('files',new Blob([markdown]),'学习原理.md');
  const upload = await app.request('/api/sources/upload',{method:'POST',raw:form});
  assert.equal(upload.status,202);
  const source = await app.ready(upload.data[0].id);
  const path = '/api/wiki/book/'+source.id;
  const post = body => app.request(path,{method:'POST',body});
  const entries = chapterStarts.map((first,index) => ({title:'导读第 '+(index+1)+' 章',level:1,first}));
  const confirmation = await post({action:'confirm',version:0,entries});
  assert.equal(confirmation.status,200,JSON.stringify(confirmation.data));
  const latest = async () => {
    const result = await app.request(path+'?job=latest');
    assert.equal(result.status,200);
    return result.data.job;
  };
  const waitForStatus = status => until(async () => {
    const job = await latest();
    return job?.status === status && job;
  },status);
  return {
    app, path, post, modelCalls, latest, waitForStatus, plan:confirmation.data,
    release() { gate?.resolve(); gate = null; },
    fail(value) { rejectModel = value; },
    blockCall(number) { blockedCall = number; },
  };
}

test('章节试生成立即返回任务，可重试查询、重复提交和失败续做，全书跳过已完成章节', {timeout:45000}, async t => {
  const f = await fixture(t,2,[1,2]);
  assert.equal(await f.latest(), null);
  const start = {action:'start',version:f.plan.version,entry_id:f.plan.entries[0].id};
  const first = await f.post(start);
  assert.equal(first.status,202,JSON.stringify(first.data));
  const id = first.data.job.id;
  assert.ok(id);
  await until(() => f.modelCalls.length === 1,'第一次模型请求');
  assert.equal((await f.latest()).id,id);
  const duplicate = await f.post(start);
  assert.equal(duplicate.data.job?.id,id,JSON.stringify(duplicate.data));
  assert.deepEqual((await f.app.request('/api/wiki')).data,[]);

  f.fail(true); f.release();
  const failed = await f.waitForStatus('failed');
  assert.equal(failed.id,id);
  assert.match(failed.error,/503/);
  f.fail(false);
  assert.ok((await f.post({action:'resume_job',job_id:id})).status < 300);
  await f.waitForStatus('done');
  assert.equal((await f.app.request('/api/wiki')).data.length,1);
  const current = (await f.app.request(f.path)).data;
  const callsBefore = f.modelCalls.length;
  const whole = await f.post({action:'start',version:current.version});
  assert.equal(whole.status,202);
  const done = await f.waitForStatus('done');
  assert.equal(done.id,whole.data.job.id);
  assert.deepEqual(f.modelCalls.slice(callsBefore).map(input => input.chapter),[current.entries[1].title]);
  assert.equal((await f.app.request('/api/wiki')).data.length,2);
});

test('长章暂停于批次边界，服务重启后保留任务编号、章节进度和模型笔记', {timeout:45000}, async t => {
  const f = await fixture(t,25,[1]);
  const start = await f.post({action:'start',version:f.plan.version,entry_id:f.plan.entries[0].id});
  assert.equal(start.status,202,JSON.stringify(start.data));
  const id = start.data.job.id;
  await until(() => f.modelCalls.length === 1,'长章第一批原文');
  const pause = await f.post({action:'pause_job',job_id:id});
  assert.ok(pause.status < 300,JSON.stringify(pause.data));
  f.release();
  await f.waitForStatus('paused');
  await until(async () => (await f.app.request(f.path)).data.entries[0].processed > 0,'批次进度写入');
  await f.app.restart();
  assert.equal((await f.latest()).id,id);
  assert.equal((await f.latest()).status,'paused');
  assert.equal(f.modelCalls.length,1);
  assert.ok((await f.post({action:'resume_job',job_id:id})).status < 300);
  await f.waitForStatus('done');
  assert.equal(f.modelCalls.length,2);
  assert.equal(f.modelCalls[1].previousNotes,'已读前一批原文。');
  const readings = f.modelCalls.flatMap(input => input.reading.map(row => row.page));
  assert.deepEqual(readings,Array.from({length:25},(_,i)=>i+1));
  assert.equal((await f.app.request('/api/wiki')).data.length,1);
});

test('运行中的长章在重启后自动恢复，已保存批次不再次请求模型', {timeout:45000}, async t => {
  const f = await fixture(t,25,[1]);
  f.blockCall(2);
  const start = await f.post({action:'start',version:f.plan.version,entry_id:f.plan.entries[0].id});
  assert.equal(start.status,202);
  await until(() => f.modelCalls.length === 2,'已保存首批并请求第二批');
  assert.equal((await f.latest()).status,'running');
  assert.equal((await f.app.request(f.path)).data.entries[0].processed,20);
  await f.app.stop();
  f.release();
  await f.app.start();
  const finished = await f.waitForStatus('done');
  assert.equal(finished.id,start.data.job.id);
  assert.equal(f.modelCalls.length,3);
  assert.deepEqual(f.modelCalls[2].reading,f.modelCalls[1].reading);
  assert.equal(f.modelCalls[2].previousNotes,'已读前一批原文。');
  assert.equal((await f.app.request('/api/wiki')).data.length,1);
});
