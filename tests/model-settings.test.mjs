import test from 'node:test';
import assert from 'node:assert/strict';
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
