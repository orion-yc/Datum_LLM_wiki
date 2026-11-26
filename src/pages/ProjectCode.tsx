import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { ErrorBox, Loading } from '../ui';

type AmdLoader = {
  config: (options: {paths: {vs: string}}) => void;
  (modules: string[], success: (editor: typeof Monaco) => void, failure: () => void): void;
};
let loading: Promise<typeof Monaco> | undefined;
function loadEditor() {
  if (loading) return loading;
  loading = new Promise<typeof Monaco>((resolve,reject) => {
    const host = window as Window & {require?: AmdLoader;monaco?: typeof Monaco};
    const fail = () => reject(new Error('代码编辑器加载失败。'));
    const css = '/monaco/vs/editor/editor.main.css';
    if (!document.querySelector(`link[href="${css}"]`)) {
      const style = document.createElement('link');
      style.rel = 'stylesheet'; style.href = css;
      document.head.append(style);
    }
    const boot = () => {
      if (!host.require) return fail();
      host.require.config({paths:{vs:'/monaco/vs'}});
      host.require(['vs/editor/editor.main'], editor => {
        const api = host.monaco || editor;
        if (api?.editor) resolve(api);
        else fail();
      },fail);
    };
    if (host.require) return boot();
    const script = document.createElement('script');
    script.src = '/monaco/vs/loader.js';
    script.onload = boot;
    script.onerror = () => { script.remove(); fail(); };
    document.head.append(script);
  }).catch(error => { loading=undefined; throw error; });
  return loading;
}
const modes: Record<string,string> = { cpp:'cpp', cxx:'cpp', cc:'cpp', c:'cpp', h:'cpp', hpp:'cpp', inl:'cpp',
  js:'javascript', jsx:'javascript', mjs:'javascript', ts:'typescript', tsx:'typescript', py:'python',
  sh:'shell', bash:'shell', yml:'yaml', yaml:'yaml', md:'markdown', markdown:'markdown' };

export default function ProjectCode({ body,path,line,wrap,onRange,onPosition,search }: {
  body: string; path: string; line: number; wrap: boolean; search: number;
  onRange: (first: number,last: number,column: number) => void; onPosition: (line: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor>(null);
  const [api,setApi] = useState<typeof Monaco>();
  const [failure,setFailure] = useState('');
  const [retry,setRetry] = useState(0);
  const callbacks = useRef({onRange,onPosition,line,wrap});
  callbacks.current = {onRange,onPosition,line,wrap};
  useEffect(() => {
    let alive = true;
    loadEditor().then(value=>{if(alive)setApi(value);},err=>{if(alive)setFailure(err.message);});
    return ()=>{alive=false;};
  },[retry]);
  useEffect(() => {
    if (!api || !container.current) return;
    const model = api.editor.createModel(body,modes[path.split('.').pop()?.toLowerCase() || ''] || 'plaintext');
    const instance = api.editor.create(container.current, {
      model, readOnly:true, domReadOnly:true, automaticLayout:true, minimap:{enabled:false}, fontSize:13,
      folding:true, scrollBeyondLastLine:false, wordWrap:callbacks.current.wrap ? 'on' : 'off',
      overviewRulerLanes:0, ariaLabel:'带行号的源码', accessibilitySupport:'auto',
    });
    editor.current = instance;
    const report = () => {
      const s = instance.getSelection();
      if (s) callbacks.current.onRange(s.startLineNumber,s.endLineNumber,s.positionColumn);
    };
    const selection = instance.onDidChangeCursorSelection(report);
    const scroll = instance.onDidScrollChange(e => {
      if (e.scrollTopChanged) callbacks.current.onPosition(instance.getVisibleRanges()[0]?.startLineNumber || 1);
    });
    instance.setPosition({lineNumber:callbacks.current.line,column:1});
    instance.revealLineInCenterIfOutsideViewport(callbacks.current.line);
    report();
    return () => { selection.dispose(); scroll.dispose(); instance.dispose(); model.dispose(); editor.current = null; };
  },[api,body,path]);
  useEffect(() => {
    if (!editor.current) return;
    editor.current.setPosition({lineNumber:line,column:1});
    editor.current.revealLineInCenterIfOutsideViewport(line);
  },[line]);
  useEffect(() => editor.current?.updateOptions({wordWrap:wrap?'on':'off'}),[wrap]);
  useEffect(() => { if (search) void editor.current?.getAction('actions.find')?.run(); },[search]);
  if (failure) return <ErrorBox message={failure} retry={()=>{setFailure('');setRetry(n=>n+1);}} />;
  return api ? <div ref={container} className="reader-monaco" /> : <Loading />;
}
