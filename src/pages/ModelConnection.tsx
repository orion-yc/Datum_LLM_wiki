import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Plug, Save } from 'lucide-react';
import { post, put } from '../api';
import { Badge, Button, ErrorBox, Field, Notice, useApp } from '../ui';
import type { ModelProtocol, ReasoningEffort, Settings } from '../types';

const reasoningOptions: { value: ReasoningEffort; label: string }[] = [
  { value: 'default', label: '服务商默认' },
  { value: 'none', label: '不推理（none）' },
  { value: 'minimal', label: '最低（minimal）' },
  { value: 'low', label: '低（low）' },
  { value: 'medium', label: '中（medium）' },
  { value: 'high', label: '高（high）' },
  { value: 'xhigh', label: '极高（xhigh）' },
  { value: 'max', label: '最高（max）' },
];

function endpointFor(address: string, protocol: ModelProtocol) {
  const base = address.trim().replace(/\/+$/, '');
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    const suffix = /\/(responses|chat\/completions)$/.exec(url.pathname);
    if (suffix && protocol === 'auto') return base;
    return (suffix ? base.slice(0, -suffix[0].length) : base) + (protocol === 'responses' ? '/responses' : '/chat/completions');
  } catch {
    return '';
  }
}

type Props = { saved: Settings; refresh: () => void; isAdmin: boolean };

export default function ModelConnection({ saved, refresh, isAdmin }: Props) {
  const { notify } = useApp();
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl);
  const [protocol, setProtocol] = useState(saved.protocol || 'auto');
  const [stream, setStream] = useState(saved.stream ?? false);
  const [model, setModel] = useState(saved.model);
  const [pdfModel, setPdfModel] = useState(saved.pdfModel);
  const [effort, setEffort] = useState(saved.reasoningEffort);
  const [apiKey, setApiKey] = useState(''), [clearKey, setClearKey] = useState(false);
  const [actor, setActor] = useState(''), [clearActor, setClearActor] = useState(false);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'models' | null>(null);
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const endpoint = endpointFor(baseUrl, protocol);
  const responses = protocol === 'responses' || endpoint.endsWith('/responses');
  const useStream = Boolean(stream && responses);
  const dirty = baseUrl !== saved.baseUrl || protocol !== saved.protocol || useStream !== saved.stream ||
    model !== saved.model || pdfModel !== saved.pdfModel || effort !== saved.reasoningEffort ||
    Boolean(apiKey || actor || clearKey || clearActor);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy('save');
    setError('');
    try {
      await put('/api/settings', {
        baseUrl, protocol, stream: useStream, model, reasoningEffort: effort, pdfModel,
        apiKey: apiKey || undefined, clearKey, actorHeader: clearActor ? '' : actor || undefined
      });
      notify('模型配置已保存。');
      refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function loadCatalog() {
    setBusy('models');
    setError('');
    try {
      const { models } = await post<{models: string[]}>('/api/settings/models');
      setCatalog(models);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function test() {
    setBusy('test');
    setError('');
    try {
      const result = await post('/api/settings/test');
      notify(result.message);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  return <section className="panel settings-panel model-connection">
    <div className="settings-section-title">
      <div className="settings-icon"><Plug size={22} /></div>
      <div><h2>模型连接</h2><p>设置整个空间使用的模型服务。</p></div>
      <Badge tone={saved.configured ? 'mint' : 'gray'}>{saved.configured ? '已配置' : '未配置'}</Badge>
    </div>
    <fieldset disabled={!isAdmin || !!busy}><form onSubmit={save}>
      <Button type="button" variant="secondary" onClick={() => {
        setProtocol('responses'); setStream(true); setEffort('default'); setError('');
      }}>使用 Codex 中转预设</Button>
      <Field label="API 基础地址" hint="填写服务商的基础地址或完整接口地址。">
        <input type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} maxLength={500} placeholder="https://api.example.com/v1" autoComplete="off" />
      </Field>
      <div className="form-columns">
        <Field label="接口协议">
          <select value={protocol} onChange={e => setProtocol(e.target.value as ModelProtocol)}>
            <option value="auto">按地址识别</option>
            <option value="responses">Responses</option>
            <option value="chat">Chat Completions</option>
          </select>
        </Field>
        <Field label="响应方式">
          <select disabled={!responses} value={useStream ? 'stream' : 'json'} onChange={e => setStream(e.target.value === 'stream')}>
            <option value="json">完整响应（JSON）</option>
            <option value="stream">流式响应（SSE）</option>
          </select>
        </Field>
      </div>
      {endpoint && <p className="small muted" style={{overflowWrap:'anywhere'}}>请求地址 <code>{endpoint}</code></p>}
      <Field label="模型名称" hint="可手动填写模型 ID。首次保存连接后，可向服务商获取可用模型。"><input value={model} maxLength={200} onChange={e => setModel(e.target.value)} placeholder="填写服务商提供的模型 ID" /></Field>
      <Button type="button" variant="secondary" disabled={dirty || !saved.configured} loading={busy === 'models'} onClick={loadCatalog}>获取模型列表</Button>
      {catalog && baseUrl === saved.baseUrl && (catalog.length ? <Field label="服务商可用模型">
        <select value={catalog.includes(model) ? model : ''} onChange={e => setModel(e.target.value)}>
          <option disabled value="">选择模型（共 {catalog.length} 个）</option>
          {catalog.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      </Field> : <p className="small muted">服务商返回的模型列表为空，可以手动填写模型 ID。</p>)}
      <Field label="PDF 视觉解析模型（可选）" hint="留空时使用上面的模型。PDF 视觉解析需要支持图片输入。">
        <input value={pdfModel} maxLength={200} onChange={e => setPdfModel(e.target.value)} placeholder="留空复用默认模型" />
      </Field>
      <Field label="推理强度" hint="服务商默认会省略推理参数。较高强度通常需要更长时间。">
        <select value={effort} onChange={e => setEffort(e.target.value as ReasoningEffort)}>
          {reasoningOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      <Field label="API 密钥" hint="更换域名、端口或 HTTP(S) 协议时，请重新填写该服务需要的密钥和请求头。">
        <div className="password-input">
          <input type={visible ? 'text' : 'password'} disabled={clearKey} value={apiKey} maxLength={2000}
            onChange={e => setApiKey(e.target.value)} placeholder={saved.keyConfigured ? '已保存，输入可替换' : '输入 API Key'} autoComplete="new-password" />
          <button type="button" className="icon-button" aria-label={visible ? '隐藏密钥' : '显示密钥'} onClick={() => setVisible(!visible)}>
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </Field>
      {saved.keyConfigured && <label className="check-label"><input type="checkbox" checked={clearKey} onChange={e => setClearKey(e.target.checked)} />清除已保存的密钥</label>}
      <details>
        <summary>中转站请求头{saved.actorHeaderConfigured ? '（已配置）' : '（可选）'}</summary>
        <Field label="x-openai-actor-authorization" hint="按服务商要求填写此请求头的值。">
          <input type="password" value={actor} disabled={clearActor} onChange={e => setActor(e.target.value)}
            placeholder={saved.actorHeaderConfigured ? '已保存，输入可替换' : '请求头的值'} autoComplete="new-password" />
        </Field>
        {saved.actorHeaderConfigured && <label className="check-label"><input type="checkbox" checked={clearActor}
          onChange={e => setClearActor(e.target.checked)} />清除已保存的请求头</label>}
      </details>
      {error && <ErrorBox message={error} />}
      {dirty && <p className="small muted">有未保存的更改，保存后可以测试连接。</p>}
      <div className="form-footer">
        <Button type="button" variant="secondary" loading={busy === 'test'} disabled={dirty || !saved.configured} onClick={test}><Plug size={15} />测试已保存的连接</Button>
        <Button loading={busy === 'save'} type="submit"><Save size={15} />保存设置</Button>
      </div>
    </form></fieldset>
    {!isAdmin && <Notice>模型配置由空间所有者或管理员维护。</Notice>}
  </section>;
}
