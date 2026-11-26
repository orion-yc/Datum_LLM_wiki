import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export function TextSelectionActions<T>({ paper, read, margin, children }: {
  paper: RefObject<HTMLElement | null>;
  read: (paper: HTMLElement) => { selection: T; rect: DOMRect } | null;
  margin: number;
  children: (selection: T) => ReactNode;
}) {
  const [active, setActive] = useState<{ selection: T; rect: DOMRect } | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (toolbar.current?.contains(document.activeElement)) return;
        const range = paper.current && read(paper.current);
        setActive(range && range.rect.bottom >= 0 && range.rect.top <= window.innerHeight ? range : null);
      });
    }
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') { document.getSelection()?.removeAllRanges(); setActive(null); } };
    document.addEventListener('selectionchange', update);
    document.addEventListener('scroll', update, true);
    document.addEventListener('keydown', dismiss);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('scroll', update, true);
      document.removeEventListener('keydown', dismiss);
      window.removeEventListener('resize', update);
    };
  }, [paper, read]);
  if (!active) return null;
  const { selection, rect } = active;
  const left = Math.min(window.innerWidth - margin, Math.max(margin, rect.left + rect.width / 2));
  const top = rect.top > 54 ? rect.top - 49 : Math.min(window.innerHeight - 48, rect.bottom + 6);
  return <div ref={toolbar} className="reader-selection-toolbar" role="toolbar" aria-label="选中文本操作" style={{ left, top }}
    onMouseDown={e => e.preventDefault()}>
    {children(selection)}
  </div>;
}
