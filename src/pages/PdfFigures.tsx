import { memo, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import './PdfFigures.css';

type Figure = { index: number; kind: 'figure' | 'page' };
const observing = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;
const waiting = new Map<Element, () => Promise<void>>();
let running = 0;

// Poppler may need to render a page on the first visit. Only prepare nearby pages.
function drain() {
  while (running < 2 && waiting.size) {
    const [node, load] = waiting.entries().next().value!;
    waiting.delete(node);
    running++;
    void load().finally(() => { running--; drain(); });
  }
}

export function OriginalPageLink({ href, page }: { href: string; page: number }) {
  return <a className="text-button pdf-original-link" href={href} target="_blank" rel="noreferrer">查看第 {page} 页整页原图</a>;
}

export const PdfFigures = memo(function PdfFigures({ sourceId, page, showOriginal = true }: { sourceId: string; page: number; showOriginal?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [figures, setFigures] = useState<Figure[]>([]), [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const path = `/api/sources/${sourceId}/pdf-figures/${page}`;
  useEffect(() => {
    const node = root.current!;
    const controller = new AbortController();
    let started = false;
    setFigures([]); setError(false);
    const update = (visible: boolean) => {
      if (!visible) { waiting.delete(node); return; }
      if (started) return;
      waiting.set(node, async () => {
        started = true;
        try {
          const result = await api<{ figures: Figure[] }>(path, { signal: controller.signal });
          if (!controller.signal.aborted) setFigures(result.figures.filter(figure => figure.kind === 'figure'));
        } catch { if (!controller.signal.aborted) setError(true); }
      });
      drain();
    };
    observer ??= new IntersectionObserver(entries => entries.forEach(e => observing.get(e.target)?.(e.isIntersecting)), { rootMargin: '180px' });
    observing.set(node, update);
    observer.observe(node);
    return () => {
      observer?.unobserve(node);
      observing.delete(node); waiting.delete(node); controller.abort();
    };
  }, [path, attempt]);
  return <div className="pdf-figures" ref={root} onClick={e => e.stopPropagation()}>
    {figures.map(({ index }, i) => {
      const label = `第 ${page} 页插图 ${i + 1}`;
      return <figure key={index}><a href={`${path}/${index}`} target="_blank" rel="noreferrer">
        <img src={`${path}/${index}`} alt={label} decoding="async" loading="lazy" onError={() => setError(true)} />
      </a><figcaption>{label}</figcaption></figure>;
    })}
    {error && <span className="muted small">插图加载失败。<button type="button" className="text-button" onClick={() => setAttempt(a => a + 1)}>重试</button></span>}
    {showOriginal && <OriginalPageLink href={`${path}/original`} page={page} />}
  </div>;
});

export function ImageOnlyPages({ first, last, sourceId }: { first: number; last: number; sourceId: string }) {
  const [number, setNumber] = useState(first);
  const page = Math.max(first, Math.min(last, number));
  return <div className="pdf-image-pages">
    <div className="chunk-caption"><h2>{first === last ? `第 ${first} 页` : `第 ${first}–${last} 页`}</h2>
      {first < last && <div className="pdf-image-navigation">
        <button type="button" className="text-button" disabled={page <= first} onClick={() => setNumber(page - 1)}>上一原页</button>
        <form key={page} onSubmit={e => { e.preventDefault(); setNumber(Number(new FormData(e.currentTarget).get('page'))); }}>
          <label>查看页码 <input name="page" type="number" min={first} max={last} defaultValue={page} required /></label>
          <button type="submit" className="text-button">跳转</button>
        </form>
        <button type="button" className="text-button" disabled={page >= last} onClick={() => setNumber(page + 1)}>下一原页</button>
      </div>}
    </div>
    <OriginalPageLink href={`/api/sources/${sourceId}/pdf-figures/${page}/original`} page={page} />
  </div>;
}
