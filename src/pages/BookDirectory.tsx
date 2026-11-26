import { BookOpen } from 'lucide-react';
import { Button } from '../ui';

export type BookDirectoryData = {
  source_id: string; title: string;
  entries: {id: string; title: string; level: number; wiki_id?: string | null}[];
};

type DirectoryNode = { entry: BookDirectoryData['entries'][number]; children: DirectoryNode[] };

function DirectoryItem({node}: {node: DirectoryNode}) {
  const {entry, children} = node;
  return <li>
    {entry.wiki_id ? <a href={'#/wiki/' + entry.wiki_id}>{entry.title}</a> : <span>{entry.title} <small>待整理</small></span>}
    {children.length > 0 && <details><summary>{children.length} 个小节</summary>
      <ul>{children.map(child => <DirectoryItem key={child.entry.id} node={child} />)}</ul>
    </details>}
  </li>;
}

export function BookDirectory({book, manage}: {book: BookDirectoryData; manage?: () => void}) {
  const roots: DirectoryNode[] = [], parents: DirectoryNode[] = [];
  for (const entry of book.entries) {
    while (parents.length && parents[parents.length-1].entry.level >= entry.level) parents.pop();
    const node: DirectoryNode = {entry, children:[]};
    const siblings = parents.at(-1)?.children ?? roots;
    siblings.push(node);
    parents.push(node);
  }
  return <section className="panel book-directory" aria-label={book.title + '章节目录'}>
    <div className="section-heading"><h2><BookOpen size={18} />{book.title} · 章节目录</h2>
      {manage && <Button variant="secondary" onClick={manage}>管理书籍目录</Button>}</div>
    <ol>{roots.map(node => <DirectoryItem key={node.entry.id} node={node} />)}</ol>
  </section>;
}
