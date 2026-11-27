import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, useApp } from '../ui';
import './BookDirectory.css';

export type BookDirectoryData = {
  source_id: string; title: string;
  entries: {id: string; title: string; level: number; wiki_id?: string | null}[];
};

type DirectoryNode = { entry: BookDirectoryData['entries'][number]; children: DirectoryNode[] };

function readingKey(sourceId: string, userId?: string) {
  return 'wiki-book:' + (userId ?? '') + ':' + sourceId;
}

export function rememberBookPage(sourceId: string, wikiId: string, userId?: string) {
  try { localStorage.setItem(readingKey(sourceId, userId), wikiId); } catch { /* Storage is optional. */ }
}

export function bookPageLink(book: BookDirectoryData, id: string, system: string) {
  return '#/wiki/' + encodeURIComponent(id) + '?' + new URLSearchParams({book:book.source_id,system});
}

function outline(book: BookDirectoryData) {
  const roots: DirectoryNode[] = [], stack: DirectoryNode[] = [];
  const parent = new Map<string, string>();
  for (const entry of book.entries) {
    while (stack.length && stack[stack.length - 1].entry.level >= entry.level) stack.pop();
    const node: DirectoryNode = {entry, children:[]};
    const ancestor = stack.at(-1);
    if (ancestor) parent.set(entry.id, ancestor.entry.id);
    (ancestor?.children ?? roots).push(node);
    stack.push(node);
  }
  return {roots, parent};
}

export function BookDirectory({book, system, manage, currentWikiId}: {
  book: BookDirectoryData; system: string; manage?: () => void; currentWikiId?: string;
}) {
  const {user} = useApp();
  const key = readingKey(book.source_id, user?.id);
  const tree = useMemo(() => outline(book), [book]);
  const lastRead = useMemo(() => {
    try {
      const wikiId = localStorage.getItem(key);
      return wikiId ? book.entries.find(entry => entry.wiki_id === wikiId) : undefined;
    }
    catch { return undefined; }
  }, [book, key]);
  const location = currentWikiId ? book.entries.find(entry => entry.wiki_id === currentWikiId) : lastRead;
  const [expanded, setExpanded] = useState(() => {
    const ids = new Set<string>();
    if (!currentWikiId) {
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(key + ':expanded') ?? '[]');
        if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') ids.add(id);
      } catch { /* A fresh directory starts collapsed. */ }
    }
    let ancestor = location && tree.parent.get(location.id);
    while (ancestor) { ids.add(ancestor); ancestor = tree.parent.get(ancestor); }
    return ids;
  });
  const region = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (currentWikiId) {
      const row = region.current?.querySelector<HTMLElement>('[aria-current="page"]');
      const container = region.current?.closest<HTMLElement>('[role="dialog"]');
      if (row && container) {
        const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
        if (offset < 0 || offset + row.offsetHeight > container.clientHeight) container.scrollTop += offset - container.clientHeight / 3;
      }
    } else {
      try {
        const scroll = sessionStorage.getItem(key + ':scroll');
        if (scroll !== null) {
          window.scrollTo(0, Number(scroll));
          sessionStorage.removeItem(key + ':scroll');
        }
      } catch { /* Storage is optional. */ }
    }
  }, [currentWikiId, key]);

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
    if (!currentWikiId) {
      try { sessionStorage.setItem(key + ':expanded', JSON.stringify([...next])); } catch { /* Storage is optional. */ }
    }
  }

  function savePosition() {
    if (!currentWikiId) {
      try { sessionStorage.setItem(key + ':scroll', String(window.scrollY)); } catch { /* Storage is optional. */ }
    }
  }

  function renderNode({entry, children}: DirectoryNode) {
    const open = expanded.has(entry.id);
    const Arrow = open ? ChevronDown : ChevronRight;
    return <li key={entry.id}>
      <div className="directory-entry">
        {children.length > 0 ? <button type="button" className="directory-toggle"
          aria-label={(open ? '收起' : '展开') + entry.title} aria-expanded={open} onClick={() => toggle(entry.id)}>
          <Arrow size={16} />
        </button> : <span className="directory-toggle-space" />}
        {entry.wiki_id ? <a href={bookPageLink(book,entry.wiki_id,system)} onClick={savePosition}
          aria-current={currentWikiId === entry.wiki_id ? 'page' : undefined}>{entry.title}</a> :
          <span>{entry.title} <small>待整理</small></span>}
      </div>
      {children.length > 0 && open && <ul>{children.map(renderNode)}</ul>}
    </li>;
  }
  return <section ref={region} className="panel book-directory" aria-label={book.title + '章节目录'}>
    <div className="section-heading"><h2><BookOpen size={18} />{book.title} · 章节目录</h2>
      {manage && <Button variant="secondary" onClick={manage}>管理书籍目录</Button>}</div>
    {!currentWikiId && lastRead?.wiki_id && <a className="directory-resume" href={bookPageLink(book,lastRead.wiki_id,system)}
      onClick={savePosition}>继续阅读 · {lastRead.title}</a>}
    <ul className="book-outline-tree">{tree.roots.map(renderNode)}</ul>
  </section>;
}
