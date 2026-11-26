import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Sparkles } from 'lucide-react';
import { api } from '../api';
import { MathText } from '../MathText';
import type { WikiPage } from '../types';
import { Button, ErrorBox, Field, Modal, RichText } from '../ui';
import { wikiHeadings, type RewriteTarget } from '../wikiRewriteRange';
import './WikiRewriteDialog.css';

type Suggestion = { body: string; summary: string };
const titles = { selection: '重新总结选段', section: '重写本节', page: '整页重新总结' };
const presets = [
  ['讲清原理', '请讲清楚背后的原理，补足中间的推理步骤。'],
  ['补个例子', '请用一个具体例子串起这里的概念。'],
  ['核对原文', '请对照原文依据核查关键结论，并指出资料不足之处。'],
];

function Preview({ label, body, summary, onCitation }: {
  label: string; body: string; summary?: string; onCitation: (n: number) => void;
}) {
  const prefix = useId();
  const headings = summary !== undefined ? wikiHeadings(body) : [];
  const intro = body.slice(0, headings[0]?.start ?? body.length);
  return <section className="rewrite-preview" aria-label={label}>
    <h3>{label}</h3>
    {headings.length > 0 && <details className="rewrite-outline" open><summary>章节目录</summary>
      <nav aria-label={label + '目录'}>{headings.map(h =>
        <button key={h.start} type="button" className="text-button"
          onClick={() => document.getElementById(prefix + h.start)?.scrollIntoView({ block: 'nearest' })}>
          <MathText text={h.label} />
        </button>)}</nav>
    </details>}
    <div className="rewrite-prose">
      {summary && <div className="rewrite-summary"><strong>摘要</strong><RichText math text={summary} onCitation={onCitation} /></div>}
      {intro && <RichText math text={intro} onCitation={onCitation} />}
      {headings.map((h, i) => <div key={h.start} id={prefix + h.start}>
        <RichText math text={body.slice(h.start, headings[i + 1]?.start)} onCitation={onCitation} />
      </div>)}
    </div>
  </section>;
}

export default function WikiRewriteDialog({ page, target, onClose, onApply }: {
  page: WikiPage; target: RewriteTarget; onClose: () => void;
  onApply: (result: Suggestion) => Promise<void> | void;
}) {
  const [feedback, setFeedback] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState<'generate' | 'apply' | null>(null);
  const [error, setError] = useState('');
  const [citationNumber, setCitationNumber] = useState(0);
  const evidenceBox = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const full = target.scope === 'page';
  const original = page.body.slice(target.start, target.end);
  const evidence = page.citations[citationNumber - 1];
  const close = () => { if (busy !== 'apply') onClose(); };

  function cite(n: number) {
    setCitationNumber(n);
    requestAnimationFrame(() => evidenceBox.current?.scrollIntoView({ block: 'nearest' }));
  }

  async function generate() {
    if (controller.current || busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy('generate'); setError('');
    try {
      const result = await api<Suggestion>('/api/wiki/rewrite', {
        method: 'POST', signal: request.signal, body: JSON.stringify({
          ...(page.id && { id: page.id, _version: page._version }),
          title: page.title, body: page.body, summary: page.summary,
          citations: page.citations.map(({ chunk_id, source_id }) => ({ chunk_id, source_id })),
          ...target, feedback: feedback.trim(), previous: suggestion ?? undefined,
        }),
      });
      if (!request.signal.aborted) {
        setSuggestion(result); setFeedback(''); setCitationNumber(0);
      }
    } catch (err) {
      if (!request.signal.aborted) setError((err as Error).message);
    } finally {
      controller.current = null;
      if (!request.signal.aborted) setBusy(null);
    }
  }

  async function apply() {
    if (busy || !suggestion) return;
    setBusy('apply'); setError('');
    try {
      await onApply({
        body: page.body.slice(0, target.start) + suggestion.body + page.body.slice(target.end),
        summary: full ? suggestion.summary : page.summary,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message); setBusy(null);
    }
  }

  return createPortal(<Modal title={titles[target.scope]} subtitle={page.title} onClose={close} wide className="rewrite-dialog">
    <Field label="修改意见"><textarea rows={2} maxLength={2000} value={feedback} disabled={!!busy}
      placeholder={suggestion ? '还希望怎样调整这一版？' : '例如：这一段省略了推理过程，请用一个例子讲清楚。可留空。'}
      onChange={e => setFeedback(e.target.value)} /></Field>
    <div className="rewrite-controls">
      <div className="rewrite-presets">{presets.map(([label, prompt]) => <button type="button" key={label} disabled={!!busy}
        onClick={() => setFeedback(value => [value.trim(), prompt].filter(Boolean).join('\n').slice(0, 2000))}>{label}</button>)}</div>
      <Button type="button" variant={suggestion ? 'secondary' : 'primary'} loading={busy === 'generate'} disabled={!!busy}
        onClick={generate}><Sparkles size={15} />{busy === 'generate' ? '正在生成…' : suggestion ? '继续调整' : '生成改写建议'}</Button>
    </div>
    {error && <ErrorBox message={error} />}
    <div className={'rewrite-comparison' + (suggestion ? ' has-suggestion' : '')}>
      <Preview label="当前草稿" body={original} summary={full ? page.summary : undefined} onCitation={cite} />
      {suggestion && <Preview label="建议改写" body={suggestion.body} summary={full ? suggestion.summary : undefined} onCitation={cite} />}
    </div>
    {citationNumber > 0 && <div className="rewrite-evidence" ref={evidenceBox}>
      {evidence ? <><strong>［{citationNumber}］{evidence.source_title} · {evidence.heading}</strong>
        <p><MathText text={evidence.excerpt} /></p>
        <a className="text-button" target="_blank" rel="noreferrer"
          href={'#/library/' + encodeURIComponent(evidence.source_id) + '?chunk=' + encodeURIComponent(evidence.chunk_id)}>
          查看原文 <ExternalLink size={13} /></a></> : <p>当前草稿尚未关联这条原文依据。</p>}
    </div>}
    <div className="form-footer"><Button type="button" variant="secondary" disabled={busy === 'apply'} onClick={close}>关闭</Button>
      {suggestion && <Button type="button" disabled={!!busy} loading={busy === 'apply'} onClick={apply}>
        {full ? '采用整页改写' : '采用这次改写'}</Button>}
    </div>
  </Modal>, document.body);
}
