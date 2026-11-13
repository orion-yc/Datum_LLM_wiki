import { config, decrypt } from './db.mjs';

export function modelSettings() { return { baseUrl: config('model_base_url'), model: config('model_name'), keyConfigured: Boolean(config('model_api_key')), configured: Boolean(config('model_base_url') && config('model_name')) }; }
export async function complete(messages, { test = false } = {}) {
  const settings = modelSettings();
  if (!settings.configured) throw Object.assign(new Error('请先在设置中配置模型地址与模型名称。'), { status: 400 });
  const key = decrypt(config('model_api_key'));
  let response;
  try {
    response = await fetch(settings.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: settings.model, messages, temperature: 0.25, ...(test ? { max_tokens: 16 } : { max_tokens: 2400 }) }),
      signal: AbortSignal.timeout(test ? 20000 : 60000),
    });
  } catch (error) { throw Object.assign(new Error(error.name === 'TimeoutError' ? '模型响应超时，请稍后重试。' : '无法连接模型服务，请检查服务地址和网络。'), { status: 502 }); }
  if (!response.ok) throw Object.assign(new Error(`模型服务返回 HTTP ${response.status}，请检查模型名称、密钥和服务额度。`), { status: 502 });
  let data;
  try { data = await response.json(); } catch { throw Object.assign(new Error('模型服务没有返回有效的 JSON。'), { status: 502 }); }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('模型服务未返回文本回答。'), { status: 502 });
  return content.trim();
}
