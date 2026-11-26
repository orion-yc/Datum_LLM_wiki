import { useEffect, useRef, useState } from 'react';
import { MessageCircleQuestion, Sparkles } from 'lucide-react';
import { wikiSectionAt, wikiSelectionOffsets, type RewriteTarget } from '../wikiRewriteRange';
import { MathText } from '../MathText';
import { api } from '../api';
import type { WikiPage } from '../types';
import { Button, ErrorBox, Field, Modal, RichText, useApp } from '../ui';
import { TextSelectionActions } from './TextSelectionActions';

function formulaAt(node: Node) {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest('.formula-block, .formula-inline');
}

function readWikiSelection(paper: HTMLElement) {
  const native = window.getSelection();
  if (!native?.rangeCount || native.isCollapsed) return null;
  const range = native.getRangeAt(0).cloneRange();
  if (!paper.contains(range.commonAncestorContainer)) return null;

  // KaTeX includes both visual and accessibility trees. Quote the source once.
  const first = formulaAt(range.startContainer), last = formulaAt(range.endContainer);
  if (first) range.setStartBefore(first);
  if (last) range.setEndAfter(last);
  const contents = range.cloneContents();
  for (const control of contents.querySelectorAll('[data-rewrite-control]')) control.remove();
  for (const formula of contents.querySelectorAll('.formula-inline, .formula-block')) {
    const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex) formula.replaceWith('$' + tex + '$');
  }
  for (const block of contents.querySelectorAll('.text-line, .text-gap, h4, pre, tr')) block.append('\n');
  for (const cell of contents.querySelectorAll('td, th')) cell.append('\t');
  const quote = contents.textContent?.trim();
  return quote ? { selection: { quote, target: wikiSelectionOffsets(paper, range) }, rect: range.getBoundingClientRect() } : null;
}

function QuestionDialog({ page, quote, close }: { page: WikiPage; quote: string; close: () => void }) {
  const [question, setQuestion] = useState(''), [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setAnswer('');
    try {
      const result = await api<{ answer: string }>(`/api/wiki/${page.id}/ask-selection`, {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ quote, question: question.trim() || '请用通俗的语言解释这段内容。', _version: page._version }),
      });
      if (!controller.signal.aborted) setAnswer(result.answer);
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <Modal title="选中提问" subtitle={page.title} onClose={close}>
    <blockquote className="reader-quote"><MathText text={quote} /></blockquote>
    <form onSubmit={ask}>
      <Field label="你的问题"><textarea rows={2} maxLength={2000} placeholder="请用通俗的语言解释这段内容。" value={question}
        onChange={e => setQuestion(e.target.value)} disabled={busy} /></Field>
      <div className="form-footer"><Button type="submit" loading={busy}>{busy ? '正在回答…' : '发送问题'}</Button></div>
    </form>
    {error && <ErrorBox message={error} />}
    {answer && <section aria-label="AI 回答" aria-live="polite"><h3>AI 回答</h3><RichText math text={answer} /></section>}
  </Modal>;
}

export default function WikiSelectionQuestion({ page, onCitation, onRewrite, allowAsk = true }: {
  page: WikiPage;
  onCitation?: (n: number) => void;
  onRewrite?: (target: RewriteTarget) => void;
  allowAsk?: boolean;
}) {
  const { canEdit, notify } = useApp();
  const paper = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState('');
  const rewrite = canEdit && page.status === 'draft' ? onRewrite : undefined;
  return <><div className="wiki-question-body" ref={paper}><RichText math text={page.body || '正文尚未整理'} onCitation={onCitation}
    onSection={rewrite && (offset => {
      const target = wikiSectionAt(page.body, offset);
      if (target) rewrite(target);
    })} /></div>
    {page.body && canEdit && !quote && (allowAsk || rewrite) && <TextSelectionActions paper={paper} read={readWikiSelection} margin={allowAsk && rewrite ? 101 : 56}>{selection => <>
      {allowAsk && <button type="button" onClick={() => {
        if (selection.quote.length > 4000) { notify('选中的内容超过 4000 字，请缩小选区。', 'error'); return; }
        setQuote(selection.quote);
        window.getSelection()?.removeAllRanges();
      }}><MessageCircleQuestion size={15} />问 AI</button>}
      {rewrite && selection.target && <button type="button" onClick={() => {
        window.getSelection()?.removeAllRanges();
        if (selection.target) rewrite(selection.target);
      }}><Sparkles size={15} />重新总结</button>}
    </>}</TextSelectionActions>}
    {quote && <QuestionDialog page={page} quote={quote} close={() => setQuote('')} />}
  </>;
}
