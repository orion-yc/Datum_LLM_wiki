import { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronRight } from 'lucide-react';
import { useData, useRoute } from '../api';
import { Button, Modal, useApp } from '../ui';
import { BookDirectory, bookPageLink, rememberBookPage, type BookDirectoryData } from './BookDirectory';
import './BookReading.css';

type Entry = BookDirectoryData['entries'][number];
type Position = { book: BookDirectoryData; index: number; system: string; directory: string };

export function useBookPosition(id: string, pageSystem?: string | null): Position | null {
  const {revision, user} = useApp();
  const {query} = useRoute();
  const system = (query.get("book") && query.get("system")) || pageSystem;
  const {data} = useData<BookDirectoryData[]>(system ? '/api/wiki/systems/' + system + '/books' : null, revision);
  const matches = data?.filter(book => book.entries.some(entry => entry.wiki_id === id));
  const book = matches?.find(item => item.source_id === query.get('book')) ?? matches?.[0];
  useEffect(() => {
    if (book) rememberBookPage(book.source_id, id, user?.id);
  }, [book, id, user?.id]);
  if (!book || !system) return null;
  return { book, system, index: book.entries.findIndex(entry => entry.wiki_id === id),
    directory: '#/wiki?' + new URLSearchParams({system, book:book.source_id}) };
}


export function BookBreadcrumb({position}: {position: Position}) {
  const {book,index,system,directory} = position;
  const [open,setOpen] = useState(false);
  const [side,setSide] = useState(false);
  const current = book.entries[index];
  const parents: Entry[] = [];
  let level = current.level;
  for (let i = index - 1; i >= 0 && level > 1; i--) {
    if (book.entries[i].level < level) {
      parents.unshift(book.entries[i]);
      level = book.entries[i].level;
    }
  }
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!(side || open)) return;
    const element = treeRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const pane = element?.closest<HTMLElement>('.book-reader-pane,.modal');
    if (element && pane) pane.scrollTop += element.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 2;
  }, [open,side,current.id]);
  const tree = <div ref={treeRef}><BookDirectory book={book} system={system} currentWikiId={current.wiki_id!} /></div>;
  return <>
    <nav className="book-reading-path" aria-label="书籍阅读位置">
      <a href={directory}>{book.title}</a>
      {parents.map(entry => <span key={entry.id}><ChevronRight size={13} />
        {entry.wiki_id ? <a href={bookPageLink(book,entry.wiki_id!,system)}>{entry.title}</a> : entry.title}</span>)}
      <span aria-current="page"><ChevronRight size={13} />{current.title}</span>
      <Button variant="secondary" onClick={() => {
        if (window.matchMedia('(min-width: 1151px)').matches) setSide(!side);
        else setOpen(true);
      }}><BookOpen size={15} />{side ? '收起目录' : '章节目录'}</Button>
    </nav>
    {side && <aside className="book-reader-pane" aria-label="本书目录">
      <Button variant="ghost" onClick={() => setSide(false)}>关闭目录</Button>{tree}
    </aside>}
    {open && <Modal title="章节目录" className="book-directory-drawer" onClose={() => setOpen(false)}>{tree}</Modal>}
  </>;
}

export function BookPageTurns({position}: {position: Position}) {
  const {book,index,system,directory} = position;
  const previous = book.entries.slice(0,index).reverse().find(entry => entry.wiki_id);
  const current = book.entries[index], next = book.entries[index+1];
  const nextLabel = next?.level === 1 ? '下一章' : current.level === 1 ? '开始本章' : '下一节';
  const skip = next && !next.wiki_id ? book.entries.slice(index+2).find(entry => entry.wiki_id) : undefined;
  return <nav className="book-page-turns" aria-label="章节翻页">
    {previous && <a href={bookPageLink(book,previous.wiki_id!,system)}>上一篇 · {previous.title}</a>}
    <div>{!next ? <a href={directory}>返回全书目录</a> : next.wiki_id ?
      <a href={bookPageLink(book,next.wiki_id!,system)}>{nextLabel} · {next.title} →</a> :
      <span>{nextLabel} · {next.title}（待整理）</span>}
      {skip && <a className="book-skip" href={bookPageLink(book,skip.wiki_id!,system)}>跳到下一篇可读内容 · {skip.title}</a>}
    </div>
  </nav>;
}
