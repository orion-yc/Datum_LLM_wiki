import { useMemo, useState } from 'react';
import GithubSlugger from 'github-slugger';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { ImageOff, RefreshCw } from 'lucide-react';

type Position = { start: {line: number}; end: {line: number} };
type Node = { type: string; depth?: number; value?: string; children?: Node[]; position?: Position };
const parser = unified().use(remarkParse).use(remarkGfm);
const label = (node: Node): string => node.value || node.children?.map(label).join('') || '';
export function documentStructure(text: string) {
  const nodes = (parser.parse(text) as Node).children || [];
  const slugger = new GithubSlugger();
  return {
    headings: nodes.flatMap(node => node.type === 'heading' && node.position
      ? [{id:slugger.slug(label(node)),title:label(node),line:node.position.start.line,depth:node.depth || 1}] : []),
    blocks: nodes.flatMap(node => node.position && ['heading','paragraph','list','blockquote','table'].includes(node.type)
      ? [{first:node.position.start.line,last:node.position.end.line}] : []),
  };
}
export function projectReference(href: string, path: string) {
  if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(href)) return null;
  try {
    const origin = 'https://repository.invalid';
    const target = new URL(href, origin+'/'+path.split('/').map(encodeURIComponent).join('/'));
    if (target.origin !== origin) return null;
    const file = target.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
    const hash = decodeURIComponent(target.hash.slice(1));
    if (!file || file.split('/').some(p=>!p || p==='.' || p==='..') || /[\x00-\x1f\\]/.test(file)) return null;
    return { file, hash };
  } catch { return null; }
}
export const isRaster = (path: string) => /\.(png|jpe?g|gif|webp)$/i.test(path);
export function RepositoryImage({ src, alt, href, lazy = true }: {src: string; alt: string; href?: string; lazy?: boolean}) {
  const [failed,setFailed] = useState(false), [retry,setRetry] = useState(0);
  if (failed) return <span className="reader-image-unavailable"><ImageOff size={16} />{alt || '图片暂无法预览'}
    <button type="button" aria-label="重试加载图片" title="重试加载图片" onClick={()=>{setRetry(n=>n+1);setFailed(false);}}><RefreshCw size={15} /></button>
    {href && <a href={href} target="_blank" rel="noreferrer">GitHub</a>}</span>;
  return <img loading={lazy?'lazy':'eager'} decoding="async" src={retry ? src+'&retry='+retry : src} alt={alt} onError={()=>setFailed(true)} />;
}
export default function ProjectMarkdown({ body,path,imageUrl,remoteUrl,inScope,openFile,selectLine,lineOffset=0 }: {
  body:string; path:string; imageUrl:(path:string)=>string; remoteUrl:(path:string)=>string;
  inScope:(path:string)=>boolean; openFile:(file:string,anchor?:string)=>void; selectLine?:(line:number)=>void;
  lineOffset?:number;
}) {
  const {headings} = useMemo(()=>documentStructure(body),[body]);
  const heading = (tag: 'h1'|'h2'|'h3'|'h4'|'h5'|'h6'): Components['h1'] =>
    ({node,children}) => {
      const Tag = tag;
      const line = node?.position?.start.line || 1, h=headings.find(v=>v.line===line);
      return <Tag data-reader-id={h?.id} data-reader-line={line+lineOffset}>{children}
        {h && selectLine && <button type="button" className="reader-heading-link" aria-label={`定位章节 ${h.title}`} title="定位章节" onClick={()=>selectLine(line+lineOffset)}>#</button>}
      </Tag>;
    };
  const components:Components = {
    h1:heading('h1'),h2:heading('h2'),h3:heading('h3'),h4:heading('h4'),h5:heading('h5'),h6:heading('h6'),
    a:({href,children})=>{
      if(!href) return <span>{children}</span>;
      const ref=projectReference(href,path);
      if(!ref) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
      if(!inScope(ref.file)) return <a href={remoteUrl(ref.file)+(ref.hash ? '#'+encodeURIComponent(ref.hash) : '')} target="_blank" rel="noreferrer">{children}</a>;
      return <a href={remoteUrl(ref.file)+(ref.hash ? '#'+encodeURIComponent(ref.hash) : '')}
        onClick={e=>{if (!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){e.preventDefault();openFile(ref.file,ref.hash);}}}>{children}</a>;
    },
    img:({src,alt})=>{
      const ref=src && projectReference(src,path);
      if(ref && isRaster(ref.file) && inScope(ref.file)) return <RepositoryImage key={ref.file} src={imageUrl(ref.file)} alt={alt || ref.file} href={remoteUrl(ref.file)} />;
      const href=ref ? remoteUrl(ref.file) : src && /^https?:\/\//i.test(src) ? src : undefined;
      return href ? <a href={href} target="_blank" rel="noreferrer"><ImageOff size={14} /> {alt || '查看外部图片'}</a> : <span>{alt}</span>;
    },
    table:({children})=><div className="reader-md-table"><table>{children}</table></div>,
  };
  return <div className="reader-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>{body}</Markdown></div>;
}
