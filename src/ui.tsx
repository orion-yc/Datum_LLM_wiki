import { Children, cloneElement, isValidElement, createContext, useContext, useLayoutEffect, useId, useRef, useState, type ReactNode, type ReactElement, type ButtonHTMLAttributes } from 'react';
import { X, LoaderCircle, ArrowRight, BookOpen, AlertCircle, Check, Sparkles } from 'lucide-react';

import { prepareMath } from './MathText';
import type { Member } from './types';
type Context = { revision: number; refresh: () => void; notify: (text: string, kind?: 'success' | 'error') => void; upload: () => void; user?: Member; canEdit: boolean; isAdmin: boolean };
export const AppContext = createContext<Context>({ revision: 0, refresh: () => {}, notify: () => {}, upload: () => {}, canEdit: false, isAdmin: false });
export const useApp = () => useContext(AppContext);
export function Button({ children, variant = 'primary', className = '', loading, write = false, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; loading?: boolean; write?: boolean }) {
  const { canEdit } = useApp(); if (write && !canEdit) return null;
  return <button className={`button ${variant} ${className}`} {...rest} disabled={rest.disabled || loading}>{loading && <LoaderCircle size={16} className="spin" />}{children}</button>;
}
export function IconButton({ children, label, write = true, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; write?: boolean }) { const { canEdit } = useApp(); if (write && !canEdit) return null; return <button type="button" className="icon-button" aria-label={label} title={label} {...props}>{children}</button>; }
export function Badge({ children, tone = 'purple' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function PageTitle({ eyebrow, title, description, action }: { eyebrow?: string; title: ReactNode; description?: string; action?: ReactNode }) { return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>; }
export function Empty({ title, text, action, icon }: { title: string; text: string; action?: ReactNode; icon?: ReactNode }) { return <div className="empty"><div className="empty-icon">{icon || <BookOpen size={28} />}</div><h3>{title}</h3><p>{text}</p>{action}</div>; }
export function Loading() { return <div className="loading"><LoaderCircle className="spin" size={24} /><span>正在整理你的知识空间…</span></div>; }
export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) { return <div className="error-box" role="alert"><AlertCircle size={19} /><span>{message}</span>{retry && <Button variant="ghost" onClick={retry}>重试</Button>}</div>; }
export function Notice({ children }: { children: ReactNode }) { return <div className="notice"><Sparkles size={17} /><div>{children}</div></div>; }
export function Progress({ value }: { value: number }) { return <div className="progress-track" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${value}%` }} /></div>; }
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const fieldId = useId(), hintId = `${fieldId}-hint`; let attached = false;
  const attach = (node: ReactNode): ReactNode => {
    if (!isValidElement(node)) return node;
    if (!attached && typeof node.type === 'string' && ['input', 'textarea', 'select'].includes(node.type)) { attached = true; return cloneElement(node as ReactElement<any>, { id: fieldId, 'aria-describedby': hint ? hintId : undefined }); }
    const element = node as ReactElement<{ children?: ReactNode }>;
    return element.props.children ? cloneElement(element, {}, Children.map(element.props.children, attach)) : element;
  };
  return <div className="field"><label htmlFor={fieldId} className="field-label">{label}</label>{Children.map(children, attach)}{hint && <small id={hintId}>{hint}</small>}</div>;
}
export function Modal({ title, subtitle, children, onClose, wide = false, className = '' }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null), titleId = useId(), closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const original = document.body.style.overflow; document.body.style.overflow = 'hidden';
    (ref.current?.querySelector<HTMLElement>('input:not([type="hidden"]),textarea,select') || ref.current?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); }
      if (e.key !== 'Tab') return;
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]') || [])].filter(el => el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = original; document.removeEventListener('keydown', onKey); previous?.focus({ preventScroll: true }); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="modal-heading"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton write={false} label="关闭窗口" onClick={onClose}><X size={20} /></IconButton></div>{children}</div></div>;
}
export function Confirm({ title, text, onClose, onConfirm, confirmLabel = '确认删除' }: { title: string; text: string; onClose: () => void; onConfirm: () => Promise<unknown>; confirmLabel?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title={title} onClose={() => { if (!busy) onClose(); }}><p className="muted">{text}</p>{error && <ErrorBox message={error} />}<div className="form-footer"><Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button><Button variant="danger" loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{confirmLabel}</Button></div></Modal>;
}
export function SectionTitle({ title, count, action }: { title: string; count?: number; action?: ReactNode }) { return <div className="section-heading"><h2>{title}{count !== undefined && <span className="count">{count}</span>}</h2>{action}</div>; }
export function LinkArrow({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <button type="button" className="text-button" onClick={onClick}>{children}<ArrowRight size={15} /></button>; }
export function CheckList({ checked, children, onClick }: { checked: boolean; children: ReactNode; onClick?: () => void }) { return <button type="button" className={`check-row ${checked ? 'checked' : ''}`} onClick={onClick} disabled={!onClick}><span className="checkbox">{checked && <Check size={12} />}</span><span>{children}</span></button>; }
export function RichText({ text, onCitation, anchors, math = false, onSection }: { onSection?: (offset:number)=>void; text: string; math?: boolean; onCitation?: (number: number) => void; anchors?: { id: string; offset: number }[] }) {
  const formulas = math && !anchors ? prepareMath(text) : null;
  const parts = (formulas?.text ?? text).split(/(```[\s\S]*?```)/g);
  let cursor = 0, nextAnchor = 0, owner = '';
  // Map the visible Markdown text back to the fragment offsets in the joined PDF page.
  const literal = (value: string, offset: number): ReactNode => {
    if (!anchors) return formulas ? formulas.render(value, onSection ? offset : undefined) : value;
    const pieces: ReactNode[] = [];
    let start = 0;
    while (nextAnchor < anchors.length && anchors[nextAnchor].offset < offset + value.length) {
      const anchor = anchors[nextAnchor++], cut = Math.max(0, anchor.offset - offset);
      if (cut > start) pieces.push(<span key={`text-${start}`} data-chunk={owner}>{value.slice(start, cut)}</span>);
      pieces.push(<span key={anchor.id} id={`chunk-${anchor.id}`} />);
      start = cut;
      owner = anchor.id;
    }
    pieces.push(<span key={`text-${start}`} data-chunk={owner}>{value.slice(start)}</span>);
    return pieces;
  };
  const inline = (line: string, offset: number) => line.split(/(\*\*[^*]+\*\*|\[\d+\]|`[^`]+`)/g).map((part, i) => {
    const start = offset; offset += part.length;
    if (part.startsWith('**')) return <strong key={i}>{literal(part.slice(2, -2), start + 2)}</strong>;
    if (/^\[\d+\]$/.test(part) && onCitation) return <button type="button" key={i} className="citation-inline" onClick={() => onCitation(Number(part.slice(1, -1)))}>{literal(part, start)}</button>;
    if (part.startsWith('`')) return <code key={i}>{literal(part.slice(1, -1), start + 1)}</code>;
    return literal(part, start);
  });
  const prose = (part: string, offset: number) => {
    const lines = part.split('\n'), nodes: ReactNode[] = [];
    const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
    const starts = lines.map(line => { const start = offset; offset += line.length + 1; return start; });
    const renderCells = (line: string, offset: number) => {
      let start = 0;
      return cells(line).map(cell => {
        const raw = cell.replace(/\|/g, '\\|');
        const at = line.indexOf(raw, start);
        start = at + raw.length;
        const base = offset + Math.max(0, at);
        if (!onSection || !raw.includes('\\|')) return inline(cell, base);
        return raw.split(/(\\\|)/g).map((part, i, parts) => {
          const pos = base + parts.slice(0, i).join('').length;
          return <span key={i}>{part === '\\|' ? <span data-wiki-start={formulas!.sourceOffset(pos)} data-wiki-end={formulas!.sourceOffset(pos + 2)} data-atomic>|</span> : inline(part, pos)}</span>;
        });
      });
    };
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j], separator = cells(lines[j + 1] || '');
      if (line.includes('|') && separator.length >= 2 && separator.every(cell => /^:?-{3,}:?$/.test(cell)) && cells(line).length === separator.length) {
        const headings = renderCells(line, starts[j]), rows: ReactNode[][] = [], key = j;
        j++;
        while (j + 1 < lines.length && lines[j + 1].includes('|') && cells(lines[j + 1]).length === headings.length) { j++; rows.push(renderCells(lines[j], starts[j])); }
        nodes.push(<div className="markdown-table" key={key} tabIndex={0}><table><thead><tr>{headings.map((cell, column) => <th key={column}>{cell}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>);
      } else {
        const prefix = /^#{1,6}[ \t]+/.exec(line)?.[0];
        if (!prefix) nodes.push(<div className={line ? 'text-line' : 'text-gap'} key={j}>{inline(line, starts[j])}</div>);
        else {
          const heading = <h4 key={j}>{inline(line.slice(prefix.length), starts[j] + prefix.length)}</h4>;
          nodes.push(onSection ? <div key={j} className="wiki-rewrite-heading">{heading}<button type="button"
            className="text-button" data-rewrite-control onClick={() => onSection(formulas?.sourceOffset(starts[j]) ?? starts[j])}>重写本节</button></div> : heading);
        }
      }
    }
    return nodes;
  };
  return <div className="rich-text">{parts.map((part, i) => {
    const start = cursor; cursor += part.length;
    if (part.startsWith('```')) {
      const prefix = /^```[^\n]*\n?/.exec(part)![0];
      const code = part.slice(prefix.length).replace(/\n?```$/, '');
      return <pre key={i}><code>{literal(code, start + prefix.length)}</code></pre>;
    }
    return <div key={i}>{prose(part, start)}</div>;
  })}{anchors?.slice(nextAnchor).map(a => <span key={a.id} id={`chunk-${a.id}`} />)}</div>;
}
