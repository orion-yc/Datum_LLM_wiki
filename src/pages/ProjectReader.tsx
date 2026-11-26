import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronRight, Clipboard, Code2, FileText, Folder, FolderOpen, Image, Languages, Link2, ListTree, Maximize2, Minimize2, PanelLeft, Search, Sparkles, WrapText, X } from 'lucide-react';
import { fileSize, navigate, post, useData } from '../api';
import { Button, Empty, ErrorBox, IconButton, Loading, useApp } from '../ui';
import ProjectMarkdown, { documentStructure, isRaster, RepositoryImage } from './ProjectMarkdown';
import './ProjectReader.css';

export type SourceRange = {path:string;first:number;last:number;total:number};
type ReaderFile = {path:string;view:'markdown'|'code'|'image'|'unsupported';body:string;total:number;reason:string;url:string;size:number};
type Node = {name:string;directory:number;kind:string;status:string;reason:string};
type Tree = {directory:string;entries:Node[];more:boolean};
type TranslationMode = 'markdown' | 'comments' | 'explain';
type Translation = {answer:string;first:number;last:number;url:string;cached:boolean};
type Tab = {path:string;line:number};
type ReaderPrefs = {tabs:Tab[];explorer:boolean;treeWidth:number};
const Code = lazy(()=>import('./ProjectCode'));
const queryPath = (endpoint:string,route:string,params:Record<string,string>)=>`${endpoint}/${route}?${new URLSearchParams(params)}`;
const fileName = (path:string)=>path.split('/').at(-1) || path;
const githubPath = (source:string,path:string)=>source.replace(/(\/blob\/[^/]+\/).+$/,'$1')+path.split('/').map(encodeURIComponent).join('/');
const fileIcon = (path:string)=>isRaster(path) ? Image : /\.(md|markdown|txt)$/i.test(path) ? FileText : Code2;

function FolderContents({endpoint,sid,directory,active,open,depth=0}:{
  endpoint:string;sid:string;directory:string;active:string;open:(p:string)=>void;depth?:number;
}) {
  const [offset,setOffset]=useState(0), [revision,setRevision]=useState(0);
  const result=useData<Tree>(queryPath(endpoint,'tree',{snapshot:sid,directory,offset:String(offset)}),revision);
  if(result.error) return <ErrorBox message={result.error} retry={()=>setRevision(n=>n+1)} />;
  if(!result.data) return <Loading />;
  const base=result.data.directory;
  return <><ul className="reader-tree-list">{result.data.entries.map(node=>{
    const path=base ? base+'/'+node.name : node.name;
    return node.directory
      ? <FolderNode key={path} node={node} endpoint={endpoint} sid={sid} path={path} active={active} open={open} depth={depth} />
      : <li key={path}><FileEntry path={path} label={node.name} active={path===active} open={open} depth={depth}
        muted={node.status!=='indexed'&&!isRaster(path)} /></li>;
  })}</ul>
  {(result.data.more || offset>0) && <div className="reader-tree-page">
    <Button variant="ghost" disabled={!offset} onClick={()=>setOffset(n=>Math.max(0,n-120))}>上一批</Button>
    <Button variant="ghost" disabled={!result.data.more} onClick={()=>setOffset(n=>n+120)}>下一批</Button>
  </div>}</>;
}
function FolderNode({node,endpoint,sid,path,active,open,depth}:{
  node:Node;endpoint:string;sid:string;path:string;active:string;open:(p:string)=>void;depth:number;
}) {
  const [expanded,setExpanded]=useState(active.startsWith(path+'/'));
  useEffect(()=>{if(active.startsWith(path+'/'))setExpanded(true);},[active,path]);
  return <li><button className="reader-tree-row" type="button" aria-expanded={expanded} title={path}
    style={{paddingInlineStart:8+Math.min(depth,8)*12}} onClick={()=>setExpanded(!expanded)}>
    <ChevronRight size={13} className={expanded?'reader-chevron expanded':'reader-chevron'} />
    {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{node.name}</span>
  </button>{expanded && <FolderContents key={path} endpoint={endpoint} sid={sid} directory={path} active={active} open={open} depth={depth+1} />}</li>;
}
function FileEntry({path,label,active,open,depth=0,muted=false}:{
  path:string;label:string;active:boolean;open:(p:string)=>void;depth?:number;muted?:boolean;
}) {
  const Icon=fileIcon(path);
  return <button className={`reader-tree-row reader-tree-file ${muted?'is-muted':''}`} type="button" aria-current={active?'page':undefined}
    style={{paddingInlineStart:24+Math.min(depth,8)*12}} onClick={()=>open(path)} title={path}><Icon size={15} /><span>{label}</span></button>;
}
function readPrefs(key:string):ReaderPrefs{
  try {
    const value=JSON.parse(sessionStorage.getItem(key)||'null');
    if(value && Array.isArray(value.tabs)) return {tabs:value.tabs.slice(0,15),explorer:value.explorer!==false,treeWidth:Math.max(170,Math.min(360,Number(value.treeWidth)||235))};
  } catch {}
  return {tabs:[],explorer:true,treeWidth:235};
}
type Props={endpoint:string;sid:string;query:URLSearchParams;scope:string;openFile:(path:string,line?:number)=>void;onLink:(r:SourceRange)=>void};
export default function ProjectReader({endpoint,sid,query,scope,openFile,onLink}:Props) {
  const {canEdit,notify}=useApp();
  const path=query.get('path')||'', line=Math.max(1,Number(query.get('line'))||1), anchor=query.get('anchor')||'';
  const key='datum-reader:'+sid;
  const [prefs,setPrefs]=useState(()=>readPrefs(key));
  const positions=useRef<Record<string,number>>(Object.fromEntries(prefs.tabs.map(t=>[t.path,t.line])));
  const [queryDraft,setQueryDraft]=useState(''), [search,setSearch]=useState(''), [offset,setOffset]=useState(0);
  const [rev,setRev]=useState(0), [markdownMode,setMarkdownMode]=useState<'preview'|'raw'|'split'|'translated'>('preview');
  const [panel,setPanel]=useState<'outline'|'translation'|''>('');
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 680px)').matches), [mobileFiles,setMobileFiles]=useState(false);
  const [focused,setFocused]=useState(false), [wrap,setWrap]=useState(false), [find,setFind]=useState(0), [fit,setFit]=useState(true);
  const [jump,setJump]=useState(line), [range,setRange]=useState({first:line,last:line,column:1});
  const [translation,setTranslation]=useState<{path:string;mode:TranslationMode;result:Translation}>(), [busy,setBusy]=useState(false), [error,setError]=useState('');
  const reading=useRef<HTMLDivElement>(null);
  const searchResults=useData<{files:{path:string}[];total:number}>(search ? queryPath(endpoint,'files',{snapshot:sid,q:search,offset:String(offset)}) : null);
  const fileResult=useData<ReaderFile>(path?queryPath(endpoint,'reader',{snapshot:sid,path}):null,rev);
  const file=fileResult.data?.path===path ? fileResult.data : null;
  const loaded=Boolean(file);
  const doc=useMemo(()=>file?.view==='markdown'?documentStructure(file.body):null,[file]);
  const shownTranslation=translation?.path===path?translation.result:null;
  const compareSource=markdownMode==='split' && shownTranslation;
  const original=useMemo(()=>file&&compareSource?file.body.split('\n').slice(compareSource.first-1,compareSource.last).join('\n'):file?.body||'',
    [file,compareSource]);

  useEffect(()=>{
    const media=matchMedia('(max-width: 680px)');
    const change=()=>setMobile(media.matches);
    media.addEventListener('change',change);
    return ()=>media.removeEventListener('change',change);
  },[]);
  useEffect(()=>{
    if(!path) return;
    setPrefs(p=>p.tabs.some(t=>t.path===path)?p:{...p,tabs:[...p.tabs,{path,line}].slice(-15)});
    setJump(line); setRange({first:line,last:line,column:1});
  },[path,line]);
  useEffect(()=>{
    setMarkdownMode('preview'); setFind(0); setFit(true); setError('');
    setPanel('');
  },[path]);
  const storePositions=useCallback(()=>{
    try { sessionStorage.setItem(key,JSON.stringify({...prefs,tabs:prefs.tabs.map(t=>({...t,line:positions.current[t.path]||t.line}))})); } catch {}
  },[key,prefs]);
  const storeTimer=useRef<number>(undefined);
  const savePosition=useCallback((n:number)=>{
    positions.current[path]=n;
    clearTimeout(storeTimer.current);
    storeTimer.current=window.setTimeout(storePositions,300);
  },[path,storePositions]);
  useEffect(()=>{storePositions();return ()=>{ clearTimeout(storeTimer.current); storePositions(); };},[storePositions]);
  const changeRange=useCallback((first:number,last:number,column:number)=>setRange({first,last,column}),[]);
  const open = (p:string,hash?:string)=>{
    setMobileFiles(false);
    const lineRef=hash?.match(/^L([1-9]\d*)(?:-L[1-9]\d*)?$/);
    if(lineRef) {openFile(p,Number(lineRef[1]));return;}
    if(hash) {
      const next=new URLSearchParams({snapshot:sid,view:'files',path:p,line:String(positions.current[p]||1),anchor:hash});
      navigate(`/projects/${endpoint.split('/').at(-1)}?${next}`);
    } else openFile(p,positions.current[p]||1);
  };
  const close=(p:string)=>{
    const tabs=prefs.tabs.filter(t=>t.path!==p);
    delete positions.current[p];
    setPrefs({...prefs,tabs});
    if(p!==path) return;
    const next=tabs[Math.min(prefs.tabs.findIndex(t=>t.path===p),tabs.length-1)];
    if(next) open(next.path);
    else navigate(`/projects/${endpoint.split('/').at(-1)}?${new URLSearchParams({snapshot:sid,view:'files'})}`);
  };
  function goLine(n:number) {
    if(!file) return;
    n=Math.min(file.total,Math.max(1,n));
    openFile(path,n);
    positions.current[path]=n;
    setJump(n);setRange({first:n,last:n,column:1});
    if(file.view==='markdown' && markdownMode!=='raw') {
      const headings=Array.from(reading.current?.querySelectorAll<HTMLElement>('[data-reader-line]') || []);
      (headings.find(el=>Number(el.dataset.readerLine)===n) || headings.filter(el=>Number(el.dataset.readerLine)<=n).at(-1))?.scrollIntoView({block:'start'});
    }
  }
  useEffect(()=>{
    if(!loaded) return;
    const frame=requestAnimationFrame(()=>{
      if(anchor){
        const target=Array.from(reading.current?.querySelectorAll<HTMLElement>('[data-reader-id]')||[]).find(el=>el.dataset.readerId===anchor);
        if(target){target.scrollIntoView({block:'start'});const n=Number(target.dataset.readerLine)||1;setRange({first:n,last:n,column:1});setJump(n);}
      } else if(markdownMode!=='raw') {
        const goal=Array.from(reading.current?.querySelectorAll<HTMLElement>('[data-reader-line]')||[]).filter(el=>Number(el.dataset.readerLine)<=line).at(-1);
        if(goal && line>1) goal.scrollIntoView({block:'start'});
      }
    });
    return ()=>cancelAnimationFrame(frame);
  },[loaded,path,line,anchor,markdownMode]);
  const translate=async(mode:TranslationMode)=>{
    if(!file) return;
    let first=range.first,last=Math.min(range.last,range.first+119);
    const head=doc?.headings.filter(h=>h.line<=range.first).at(-1);
    if(mode==='markdown'){
      first=head?.line||1;
      const next=doc?.headings.find(h=>h.line>first && (!head || h.depth<=head.depth));
      last=Math.min(file.total,next?next.line-1:file.total,first+119);
    } else if(first===last) {
      last=Math.min(file.total,first+12);
    }
    setBusy(true);setError('');setPanel('translation');
    try {
      const blocks=mode==='markdown' ? doc?.blocks.filter(b=>b.first>=first&&b.last<=last) : undefined;
      const result=await post<Translation>(endpoint+'/translate',{snapshot:sid,path,mode,first,last,blocks});
      setTranslation({path,mode,result});
      if(mode==='markdown') setMarkdownMode('split');
    }catch(err){setError((err as Error).message);}finally{setBusy(false);}
  };
  const imageUrl=(p:string)=>queryPath(endpoint,'image',{snapshot:sid,path:p});
  const remoteUrl=(p:string)=>file?githubPath(file.url,p):'#';
  const inScope=(p:string)=>!scope||p===scope||p.startsWith(scope+'/');
  const reference=()=>`${location.origin}${location.pathname}#/projects/${endpoint.split('/').at(-1)}?${new URLSearchParams({snapshot:sid,view:'files',path,line:String(range.first)})}`;
  const focusClass=focused?'focus':'';
  const showTree=!focused&&(mobile?mobileFiles:prefs.explorer);
  const handleResize=(e:React.PointerEvent<HTMLButtonElement>)=>{
    if(mobile) return;
    const start=e.clientX, width=prefs.treeWidth;
    const move=(event:PointerEvent)=>setPrefs(p=>({...p,treeWidth:Math.max(170,Math.min(360,width+event.clientX-start))}));
    const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
  };
  const textView=file && (file.view==='markdown'||file.view==='code');
  return <section aria-label="源码阅读工作台" className={`reader-workbench ${focusClass} ${showTree?'has-tree':''} ${panel?'has-inspector':''}`}
    style={{'--reader-tree-width':prefs.treeWidth+'px'} as React.CSSProperties}>
    <header className="reader-bar">
      <IconButton write={false} label="资源管理器" aria-pressed={showTree} onClick={()=>mobile?setMobileFiles(!mobileFiles):setPrefs({...prefs,explorer:!prefs.explorer})}><PanelLeft size={17} /></IconButton>
      <nav className="reader-tabs" aria-label="已打开文件">{prefs.tabs.map(tab=>{
        const Icon=fileIcon(tab.path);
        return <div className={tab.path===path?'reader-tab current':'reader-tab'} key={tab.path}>
          <button type="button" aria-current={tab.path===path?'page':undefined} title={tab.path} onClick={()=>open(tab.path)}><Icon size={14} /><span>{fileName(tab.path)}</span></button>
          <button type="button" className="reader-tab-close" aria-label={`关闭 ${tab.path}`} title="关闭标签" onClick={()=>close(tab.path)}><X size={14} /></button>
        </div>;
      })}</nav>
      <IconButton write={false} label={focused?'退出专注模式':'专注模式'} onClick={()=>setFocused(!focused)}>{focused?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</IconButton>
    </header>
    {showTree && <aside className="reader-explorer" aria-label="项目文件">
      <div className="reader-pane-title"><strong>资源管理器</strong><IconButton write={false} label="关闭资源管理器" onClick={()=>mobile?setMobileFiles(false):setPrefs({...prefs,explorer:false})}><X size={14} /></IconButton></div>
      <form className="reader-search" onSubmit={e=>{e.preventDefault();setSearch(queryDraft.trim());setOffset(0);}}>
        <input aria-label="搜索文件名或路径" placeholder="搜索文件" value={queryDraft} onChange={e=>{setQueryDraft(e.target.value);if(!e.target.value)setSearch('');}} />
        <IconButton write={false} label="搜索文件" type="submit"><Search size={15}/></IconButton>
      </form>
      <div className="reader-tree-scroll">{search ? searchResults.error ? <ErrorBox message={searchResults.error}/> : searchResults.data ? <>
        <ul className="reader-tree-list">{searchResults.data.files.map(f=><li key={f.path}><FileEntry path={f.path} label={f.path} active={f.path===path} open={open}/></li>)}</ul>
        {!searchResults.data.total && <p className="reader-no-results">没有匹配的文件</p>}
        {searchResults.data.total>60 && <div className="reader-tree-page"><Button variant="ghost" disabled={!offset} onClick={()=>setOffset(n=>n-60)}>上一批</Button>
          <Button variant="ghost" disabled={offset+60>=searchResults.data.total} onClick={()=>setOffset(n=>n+60)}>下一批</Button></div>}
      </> : <Loading/> : <FolderContents endpoint={endpoint} sid={sid} directory="" active={path} open={open}/>}</div>
      <button type="button" className="reader-resize" aria-label="调整文件树宽度" onPointerDown={handleResize}
        onKeyDown={e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();setPrefs(p=>({...p,treeWidth:Math.max(170,Math.min(360,p.treeWidth+(e.key==='ArrowRight'?15:-15)))}));}}}/>
    </aside>}
    <div className="reader-main">
      {path && <div className="reader-toolbar">
        <span className="reader-path" title={path}>{path.split('/').join(' / ')}</span>
        <div className="reader-actions">
          {file?.view==='markdown' && <div className="reader-segments" aria-label="Markdown 显示方式">
            <button type="button" aria-pressed={markdownMode==='preview'} onClick={()=>setMarkdownMode('preview')}>预览</button>
            <button type="button" aria-pressed={markdownMode==='raw'} onClick={()=>setMarkdownMode('raw')}>源文</button>
            {shownTranslation && <><button type="button" aria-pressed={markdownMode==='translated'} onClick={()=>setMarkdownMode('translated')}>中文</button><button type="button" aria-pressed={markdownMode==='split'} onClick={()=>setMarkdownMode('split')}>对照</button></>}
          </div>}
          {textView && <IconButton write={false} label={file?.view==='markdown'?'文档大纲':'切换自动换行'} aria-pressed={file?.view==='markdown'?panel==='outline':wrap} onClick={()=>file?.view==='markdown'?setPanel(panel==='outline'?'':'outline'):setWrap(!wrap)}>{file?.view==='markdown'?<ListTree size={16}/>:<WrapText size={16}/>}</IconButton>}
          {textView && (file?.view==='code'||markdownMode==='raw') && !mobile && <IconButton write={false} label="文件内查找" onClick={()=>setFind(n=>n+1)}><Search size={16}/></IconButton>}
          {file?.view==='image' && <Button variant="ghost" onClick={()=>setFit(!fit)}>{fit?'原始尺寸':'适配窗口'}</Button>}
          {file && <a className="icon-button reader-origin" href={file.url} target="_blank" rel="noreferrer" aria-label="在 GitHub 查看原文" title="在 GitHub 查看原文"><ArrowUpRight size={16}/></a>}
          {textView && <IconButton write={false} label="复制原文链接" onClick={()=>void navigator.clipboard.writeText(reference()).then(()=>notify('原文链接已复制'),()=>notify('无法复制链接','error'))}><Clipboard size={16}/></IconButton>}
          {textView && canEdit && <IconButton label="关联知识" onClick={()=>onLink({path,first:range.first,last:range.last,total:file!.total})}><Link2 size={16}/></IconButton>}
        </div>
      </div>}
      <div className="reader-document" ref={reading} onScroll={e=>{
        if(file?.view!=='markdown'||markdownMode==='raw')return;
        const top=e.currentTarget.getBoundingClientRect().top;
        const seen=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-reader-line]')).filter(h=>h.getBoundingClientRect().top<=top+40).at(-1);
        if(seen)savePosition(Number(seen.dataset.readerLine));
      }}>
        {fileResult.error && path ? <ErrorBox message={fileResult.error} retry={()=>setRev(n=>n+1)}/> : !path ? <Empty title="选择文件" text="" icon={<FileText size={24}/>} action={<Button variant="secondary" onClick={()=>mobile?setMobileFiles(true):setPrefs({...prefs,explorer:true})}>打开资源管理器</Button>}/> : !file ? <Loading/> :
          file.view==='image' ? <div key={path} className={`reader-image-view ${fit?'fit':''}`}><RepositoryImage src={imageUrl(path)} alt={fileName(path)} href={file.url} lazy={false}/></div> :
          file.view==='unsupported' ? <Empty title="该文件不支持站内预览" text={file.reason||fileSize(file.size)} action={<a href={file.url} target="_blank" rel="noreferrer">在 GitHub 查看文件</a>}/> :
          file.view==='markdown' && markdownMode!=='raw' ? <div className={markdownMode==='split'?'reader-dual':''}>
            {markdownMode!=='translated' && <ProjectMarkdown body={original} lineOffset={compareSource ? compareSource.first-1 : 0}
              path={path} imageUrl={imageUrl} remoteUrl={remoteUrl} inScope={inScope} openFile={open} selectLine={goLine}/>}
            {(markdownMode==='split'||markdownMode==='translated') && shownTranslation && <section className="reader-translated-doc">
              <h3>AI 译文 · {shownTranslation.first}–{shownTranslation.last} 行</h3>
              <ProjectMarkdown body={shownTranslation.answer} path={path} imageUrl={imageUrl} remoteUrl={remoteUrl} inScope={inScope} openFile={open}/>
              <button type="button" onClick={()=>{setMarkdownMode('preview');goLine(shownTranslation.first);}}>定位原文</button>
            </section>}
          </div> : mobile ? <MobileCode body={file.body} line={line} wrap={wrap} onRange={changeRange} onPosition={savePosition}/> :
          <Suspense fallback={<Loading/>}><Code key={path} body={file.body} path={path} line={line} wrap={wrap} search={find} onRange={changeRange} onPosition={savePosition}/></Suspense>}
      </div>
      {textView && <footer className="reader-status"><span>只读 · {file?.view==='markdown'?'Markdown':fileName(path).split('.').at(-1)?.toUpperCase()}</span>
        <span>{range.first===range.last?`行 ${range.first} · 列 ${range.column}`:`行 ${range.first}–${range.last}`} / {file?.total}</span>
        <form onSubmit={e=>{e.preventDefault();goLine(jump);}}><input aria-label="跳到行号" type="number" min={1} max={file?.total} value={jump} onChange={e=>setJump(Number(e.target.value))}/><button type="submit">跳转</button></form>
        {canEdit && <div className="reader-actions">
          {file?.view==='markdown' ? <Button variant="ghost" loading={busy} onClick={()=>void translate('markdown')}><Languages size={15}/>翻译本节</Button> : <>
            <Button variant="ghost" loading={busy} onClick={()=>void translate('comments')}><Languages size={15}/>翻译注释</Button>
            <Button variant="ghost" disabled={busy} onClick={()=>void translate('explain')}><Sparkles size={15}/>解释代码</Button></>}
        </div>}
      </footer>}
      {file?.view==='image' && <footer className="reader-status"><span>{fileName(path)}</span><span>{fileSize(file.size)}</span></footer>}
    </div>
    {panel && file && <aside className="reader-inspector" aria-label={panel==='outline'?'文档大纲':'翻译与解读'}>
      <div className="reader-pane-title"><strong>{panel==='outline'?'文档大纲':'翻译与解读'}</strong><IconButton write={false} label="关闭侧栏" onClick={()=>setPanel('')}><X size={14}/></IconButton></div>
      {panel==='outline' ? <ul className="reader-tree-list">{doc?.headings.map(h=><li key={h.id}>
        <button type="button" className="reader-tree-row" style={{paddingInlineStart:10+Math.min(h.depth-1,4)*10}} aria-current={range.first===h.line?'location':undefined} onClick={()=>goLine(h.line)}>{h.title}</button>
      </li>)}</ul> : <div className="reader-inspector-body">{busy?<Loading/>:error?<ErrorBox message={error}/>:shownTranslation&&<>
        <small>AI · 原文 {shownTranslation.first}–{shownTranslation.last} 行</small>
        {translation?.mode === 'explain' ? <ProjectMarkdown body={shownTranslation.answer} path={path}
          imageUrl={imageUrl} remoteUrl={remoteUrl} inScope={inScope} openFile={open} /> : <pre>{shownTranslation.answer}</pre>}
        <Button variant="secondary" onClick={()=>goLine(shownTranslation.first)}>定位原文</Button>
      </>}</div>}
    </aside>}
  </section>;
}

function MobileCode({body,line,wrap,onRange,onPosition}:{
  body:string;line:number;wrap:boolean;onRange:(f:number,l:number,c:number)=>void;onPosition:(n:number)=>void;
}){
  const [first,setFirst]=useState(Math.max(1,line-60));
  const lines=useMemo(()=>body.split('\n'),[body]);
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const start=Math.max(1,line-60);
    setFirst(start);
    requestAnimationFrame(()=>ref.current?.querySelector(`[data-code-line="${line}"]`)?.scrollIntoView({block:'center'}));
  },[body,line]);
  return <div ref={ref} className={`reader-mobile-code ${wrap?'wrap':''}`} aria-label="带行号的源码">
    {first>1 && <Button variant="ghost" onClick={()=>{setFirst(n=>Math.max(1,n-180));onPosition(Math.max(1,first-180));}}>向上加载</Button>}
    {lines.slice(first-1,first+179).map((text,i)=><div key={first+i} data-code-line={first+i} className={line===first+i?'highlight':''}>
      <button type="button" className="reader-line" aria-label={`选择第 ${first+i} 行`} onClick={()=>onRange(first+i,first+i,1)}>{first+i}</button><code>{text||' '}</code>
    </div>)}
    {first+179<lines.length && <Button variant="ghost" onClick={()=>{setFirst(n=>n+180);onPosition(first+180);ref.current?.scrollIntoView({block:'start'});}}>向下加载</Button>}
  </div>;
}
