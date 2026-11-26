import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { testServer } from './helpers.mjs';

test('模型推理强度：持久化、真实请求、兼容参数重试、错误边界与旧客户端', { timeout: 90000 }, async t => {
  const server = await testServer(); t.after(() => server.close());
  const { request } = server;
  assert.equal((await request('/api/auth/setup', { method: 'POST', body: { password: 'reasoning-test-password' } })).status, 201);
  assert.equal((await request('/api/settings')).data.reasoningEffort, 'default', '旧数据库未设置时使用服务商默认');
  const calls = [];
  let mode = 'success';
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); calls.push(payload);
    res.setHeader('Content-Type', 'application/json');
    const reject = (status, error) => { res.writeHead(status); res.end(JSON.stringify({ error })); };
    if (mode === 'legacy-tokens' && Object.hasOwn(payload, 'max_completion_tokens'))
      return reject(400, { message: "Unknown parameter: 'max_completion_tokens'", param: 'max_completion_tokens', code: 'unknown_parameter' });
    if (mode === 'unsupported-effort')
      return reject(400, { message: 'Unsupported reasoning_effort; upstream-private-detail', param: 'reasoning_effort' });
    if (mode === 'invalid-effort')
      return reject(422, { message: 'Invalid value for reasoning_effort', param: 'reasoning_effort' });
    if (mode === 'token-limit')
      return reject(400, { message: 'max_completion_tokens must be less than 8192', param: 'max_completion_tokens' });
    if (mode === 'both-token-fields')
      return reject(400, { message: 'Unsupported parameter: ' + (Object.hasOwn(payload, 'max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens') });
    if (mode === 'unauthorized' || mode === 'unavailable')
      return reject(mode === 'unauthorized' ? 401 : 503, { message: 'Unsupported max_completion_tokens' });
    if (mode === 'empty-answer')
      return res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'Private reasoning only' }, finish_reason: 'length' }] }));
    res.end(JSON.stringify({ choices: [{ message: { content: '根据原文进行二分查找。[1]' } }] }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => mock.close(r)));
  const connection = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'reasoning-mock' };
  const save = extra => request('/api/settings', { method: 'PUT', body: { ...connection, ...extra } });
  const testConnection = () => request('/api/settings/test', { method: 'POST' });

  assert.equal((await save()).data.reasoningEffort, 'default');
  assert.equal((await testConnection()).status, 200);
  assert.equal(Object.hasOwn(calls.at(-1), 'reasoning_effort'), false);
  assert.equal(calls.at(-1).temperature, 0.25);
  assert.equal(calls.at(-1).max_tokens, 16);
  assert.equal(Object.hasOwn(calls.at(-1), 'max_completion_tokens'), false);

  for (const reasoningEffort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal((await save({ reasoningEffort })).data.reasoningEffort, reasoningEffort);
    assert.equal((await testConnection()).status, 200);
    assert.equal(calls.at(-1).reasoning_effort, reasoningEffort);
    assert.equal(calls.at(-1).max_completion_tokens, 4096);
    assert.equal(Object.hasOwn(calls.at(-1), 'temperature'), false);
    assert.equal(Object.hasOwn(calls.at(-1), 'max_tokens'), false);
  }
  await server.restart();
  assert.equal((await request('/api/settings')).data.reasoningEffort, 'max');
  assert.equal((await save()).data.reasoningEffort, 'max', '旧客户端省略新字段时保留已保存强度');
  for (const reasoningEffort of ['unknown', '', null, 2, true, {}, []]) {
    const rejected = await save({ model: 'must-not-be-saved', reasoningEffort });
    assert.equal(rejected.status, 400);
    const stored = (await request('/api/settings')).data;
    assert.equal(stored.reasoningEffort, 'max'); assert.equal(stored.model, connection.model, '非法配置不应部分保存');
  }

  await save({ reasoningEffort: 'high' });
  const sample = (await request('/api/sources/sample', { method: 'POST' })).data;
  const source = await server.ready(sample.id);
  const chat = (await request('/api/conversations', { method: 'POST', body: { source_id: source.id } })).data;
  const ask = () => request(`/api/conversations/${chat.id}/messages`, { method: 'POST', body: { content: '二分查找的边界是什么？' } });
  assert.equal((await ask()).status, 200);
  assert.equal(calls.at(-1).reasoning_effort, 'high');
  assert.equal(calls.at(-1).max_completion_tokens, 32768, '正式生成保留足够的推理与回答预算');
  assert.equal(Object.hasOwn(calls.at(-1), 'temperature'), false);
  mode = 'legacy-tokens'; let before = calls.length;
  assert.equal((await ask()).status, 200);
  assert.equal(calls.length, before + 2);
  assert.equal(calls.at(-1).max_tokens, 32768);
  assert.equal(Object.hasOwn(calls.at(-1), 'max_completion_tokens'), false);
  assert.equal(calls.at(-2).reasoning_effort, 'high'); assert.equal(calls.at(-1).reasoning_effort, 'high');
  assert.deepEqual(calls.at(-1).messages, calls.at(-2).messages);

  const messageCount = (await request(`/api/conversations/${chat.id}`)).data.messages.length;
  for (const failure of ['unsupported-effort', 'invalid-effort', 'token-limit', 'both-token-fields', 'unauthorized', 'unavailable', 'empty-answer']) {
    mode = failure; before = calls.length;
    const result = await ask();
    assert.equal(result.status, 502, failure);
    assert.equal(calls.length, before + (failure === 'both-token-fields' ? 2 : 1), failure + '：仅未知 token 字段允许重试一次');
    if (failure.endsWith('effort')) assert.match(result.data.error, /推理强度.*服务商默认/);
    assert.ok(!JSON.stringify(result.data).includes('upstream-private-detail'));
    assert.ok(!JSON.stringify(result.data).includes('Private reasoning only'));
    assert.equal((await request(`/api/conversations/${chat.id}`)).data.messages.length, messageCount, '失败不写入对话');
    assert.equal((await request('/api/settings')).data.reasoningEffort, 'high', '失败不能降低已配置的强度');
  }
  mode = 'success';
  assert.equal((await save({ reasoningEffort: 'default' })).data.reasoningEffort, 'default');
  assert.equal((await ask()).status, 200);
  assert.equal(Object.hasOwn(calls.at(-1), 'reasoning_effort'), false);
  assert.equal(calls.at(-1).max_tokens, 4000);
});

test('中转连接使用选定协议和流式传输，按来源保存凭据', async t => {
  const app = await testServer();
  t.after(() => app.close());
  const { request } = app;
  await request('/api/auth/setup', { method: 'POST', body: { password: 'relay-test-password' } });
  const initial = (await request('/api/settings')).data;
  assert.equal(initial.protocol, 'auto');
  assert.equal(initial.stream, false);

  const calls = [];
  const content = '闭区间边界。[1]';
  const completed = { status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: content }] }] };
  let mode = 'complete';
  const event = data => 'data: ' + JSON.stringify(data) + '\r\n\r\n';
  async function listen() {
    const relay = createServer(async (req, res) => {
      const parts = [];
      for await (const part of req) parts.push(part);
      const payload = JSON.parse(Buffer.concat(parts).toString());
      calls.push({ path: req.url, headers: req.headers, payload });
      if (!payload.stream || mode === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url.endsWith('/responses') ? completed : { choices: [{ message: { content } }] }));
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      const delta = Buffer.from(': heartbeat\r\n\r\n' + event({ type: 'response.output_text.delta', delta: content }));
      const split = delta.indexOf('闭') + 1;
      res.write(delta.subarray(0, split));
      await delay(5);
      res.write(delta.subarray(split));
      if (mode === 'error') res.end(event({type:'error', code:'server_error', message:'SYNTHETIC_PRIVATE_DETAIL'}));
      else if (mode === 'incomplete') res.end(event({type:'response.incomplete', response:{status:'incomplete'}}));
      else if (mode === 'truncated') res.end();
      else res.end(event({type:'response.completed', response:mode === 'deltas' ? { status:'completed', output:[] } : completed}));
    });
    await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => relay.close(resolve)));
    return 'http://127.0.0.1:' + relay.address().port + '/v1';
  }

  const baseUrl = await listen();
  const save = (fields = {}) => request('/api/settings', { method:'PUT', body:{baseUrl, model:'relay-model', ...fields} });
  const probe = () => request('/api/settings/test', { method:'POST' });
  const key = 'synthetic-relay-bearer';
  const actor = 'synthetic-relay-actor';
  const saved = await save({ protocol:'responses', stream:true, apiKey:key, actorHeader:actor });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.endpoint, baseUrl + '/responses');
  assert.equal(saved.data.actorHeaderConfigured, true);
  await app.restart();
  for (const publicSettings of [saved.data, (await request('/api/settings')).data]) {
    assert.equal(publicSettings.protocol, 'responses');
    assert.equal(publicSettings.stream, true);
    for (const credential of [key, actor]) assert.ok(!JSON.stringify(publicSettings).includes(credential));
  }
  const db = await readFile(join(app.dataDir, 'knowledge.sqlite'));
  const wal = await readFile(join(app.dataDir, 'knowledge.sqlite-wal')).catch(e => {
    if (e.code === 'ENOENT') return Buffer.alloc(0);
    throw e;
  });
  for (const credential of [key, actor]) assert.ok(!Buffer.concat([db, wal]).includes(credential));

  const sample = (await request('/api/sources/sample', {method:'POST'})).data;
  await app.ready(sample.id);
  const chat = (await request('/api/conversations', {method:'POST',body:{source_id:sample.id}})).data;
  const ask = () => request('/api/conversations/' + chat.id + '/messages', {method:'POST',body:{content:'二分查找的边界是什么？'}});
  for (mode of ['complete', 'deltas', 'json']) {
    const answer = await ask();
    assert.equal(answer.status, 200, mode + ' ' + JSON.stringify(answer.data.error));
    assert.equal(answer.data.messages.at(-1).content, content);
    const sent = calls.at(-1);
    assert.equal(sent.path, '/v1/responses');
    assert.equal(sent.headers.authorization, 'Bearer ' + key);
    assert.equal(sent.headers['x-openai-actor-authorization'], actor);
    assert.equal(sent.payload.stream, true);
    assert.equal(sent.payload.store, false);
  }
  for (mode of ['error','incomplete','truncated']) {
    const failure = await probe();
    assert.equal(failure.status, 502, mode);
    assert.ok(!JSON.stringify(failure.data).includes('SYNTHETIC_PRIVATE_DETAIL'));
  }
  mode = 'complete';
  for (const [protocol, suffix, expected] of [
    ['auto','/responses','/responses'], ['auto','','/chat/completions'], ['chat','','/chat/completions'],
  ]) {
    const configured = await save({protocol, baseUrl:baseUrl + suffix, stream:false});
    assert.equal(configured.data.endpoint, baseUrl + expected);
    assert.equal((await probe()).status, 200);
    assert.equal(calls.at(-1).path, '/v1' + expected);
    assert.ok(!calls.at(-1).payload.stream);
  }

  const otherOrigin = await listen();
  const changed = await save({baseUrl:otherOrigin});
  assert.equal(changed.data.keyConfigured, false);
  assert.equal(changed.data.actorHeaderConfigured, false);
  assert.equal((await probe()).status, 200);
  assert.equal(calls.at(-1).headers.authorization, undefined);
  assert.equal(calls.at(-1).headers['x-openai-actor-authorization'], undefined);
});
