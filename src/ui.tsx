import { Children, cloneElement, isValidElement, createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type ReactElement, type ButtonHTMLAttributes } from 'react';
import { X, LoaderCircle, ArrowRight, BookOpen, AlertCircle, Check, Sparkles } from 'lucide-react';

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
export function PageTitle({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) { return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>; }
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
export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null), titleId = useId(), closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const original = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => (ref.current?.querySelector<HTMLElement>('input:not([type="hidden"]),textarea,select') || ref.current?.querySelector<HTMLElement>('button'))?.focus(), 40);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); }
      if (e.key !== 'Tab') return;
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]') || [])].filter(el => el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); document.body.style.overflow = original; document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="modal-heading"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton write={false} label="关闭窗口" onClick={onClose}><X size={20} /></IconButton></div>{children}</div></div>;
}
export function Confirm({ title, text, onClose, onConfirm, confirmLabel = '确认删除' }: { title: string; text: string; onClose: () => void; onConfirm: () => Promise<unknown>; confirmLabel?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title={title} onClose={() => { if (!busy) onClose(); }}><p className="muted">{text}</p>{error && <ErrorBox message={error} />}<div className="form-footer"><Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button><Button variant="danger" loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{confirmLabel}</Button></div></Modal>;
}
export function SectionTitle({ title, count, action }: { title: string; count?: number; action?: ReactNode }) { return <div className="section-heading"><h2>{title}{count !== undefined && <span className="count">{count}</span>}</h2>{action}</div>; }
export function LinkArrow({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <button type="button" className="text-button" onClick={onClick}>{children}<ArrowRight size={15} /></button>; }
export function CheckList({ checked, children, onClick }: { checked: boolean; children: ReactNode; onClick?: () => void }) { return <button type="button" className={`check-row ${checked ? 'checked' : ''}`} onClick={onClick} disabled={!onClick}><span className="checkbox">{checked && <Check size={12} />}</span><span>{children}</span></button>; }
export function RichText({ text, onCitation }: { text: string; onCitation?: (number: number) => void }) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  const inline = (line: string) => line.split(/(\*\*[^*]+\*\*|\[\d+\]|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^\[\d+\]$/.test(part) && onCitation) return <button key={i} className="citation-inline" onClick={() => onCitation(Number(part.slice(1, -1)))}>{part}</button>;
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
  return <div className="rich-text">{parts.map((part, i) => part.startsWith('```') ? <pre key={i}><code>{part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</code></pre> : <div key={i}>{part.split('\n').map((line, j) => /^#{1,4} /.test(line) ? <h4 key={j}>{inline(line.replace(/^#{1,4} /, ''))}</h4> : <div className={line ? 'text-line' : 'text-gap'} key={j}>{inline(line)}</div>)}</div>)}</div>;
}
