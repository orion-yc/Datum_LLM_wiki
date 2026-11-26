import { useEffect, useRef, useState } from 'react';
import { api, ApiError, post } from '../api';
import { Button, ErrorBox, Loading, Modal, Notice, Progress, useApp } from '../ui';
import WikiSystemPicker, { type SystemChoice } from './WikiSystemPicker';
import type { StudyProps } from './WholeStudy';
import './BookStudy.css';

type WikiLink = {id:string; title:string};
type Entry = {
  id:string; title:string; first:number; last:number; level:1|2|3; toc_page?:number; edited?:boolean; uncertain?:boolean; origin?:string;
  wiki_id?:string; reuse_id?:string; processed?:number; chunk_id?:string; matched?:WikiLink[]; crossing?:WikiLink[];
};
type Plan = {entries:Entry[]; confirmed:boolean; version:number; pages:number; configured:boolean; system_id?:string|null};

type BookJob = {
  id:string; scope:'chapter'|'all'; status:'queued'|'running'|'paused'|'failed'|'done';
  entry_id?:string; current_entry_id?:string; processed:number; plan_version:number; pause_requested?:number; error?:string;
};
const jobLabels: Record<BookJob['status'],string> = {queued:'已排队',running:'正在生成',paused:'已暂停',failed:'生成失败',done:'已完成'};

const origins:Record<string,string> = {bookmark:'PDF 书签',toc:'原书目录',heading:'正文标题',ai:'AI 建议',manual:'手动目录'};

function endPage(entries: Entry[], index: number, pages: number) {
  const entry = entries[index];
  for (let i=index+1; i<entries.length; i++) {
    if (entries[i].level <= entry.level) return Math.max(entry.first, entries[i].first-1);
  }
  return pages;
}

export default function BookStudy({ sourceId, title, pdf, initialSystem, onClose, onSegmented, onCustom, onPaper }: StudyProps & {onSegmented:()=>void}) {
  const endpoint = '/api/wiki/book/' + sourceId;
  const {refresh} = useApp();
  const [plan, setPlan] = useState<Plan|null>(null), [draft, setDraft] = useState<Entry[]|null>(null);
  const [system, setSystem] = useState<SystemChoice>(initialSystem), [pendingSystem, setPendingSystem] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [reload, setReload] = useState(0), [stale, setStale] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false), [tocFirst,setTocFirst] = useState('1'), [tocLast,setTocLast] = useState('1');
  const [pendingOnly,setPendingOnly] = useState(false), [dirty,setDirty] = useState(false);
  const active = useRef(false), mounted = useRef(true);
  const [job,setJob] = useState<BookJob|null>(null), [checkedJob,setCheckedJob] = useState(false);
  const [syncError,setSyncError] = useState(''), [pollEpoch,setPollEpoch] = useState(0);
  const planVersion = useRef(-1);
  const savedCount = useRef(0);
  const pendingStart = useRef<{entryId?:string; previousId?:string} | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const jobWorking = job?.status === 'queued' || job?.status === 'running';
  const canStart = checkedJob && !busy && !jobWorking && !syncError && !stale;
  const unit = pdf ? '页' : '节';
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = true;
    setError(''); setStale(false);
    void api<Plan>(endpoint, {signal:controller.signal}).then(next => {
      if (controller.signal.aborted) return;
      planVersion.current = next.version; savedCount.current = next.entries.filter(e=>e.wiki_id).length;
      setDirty(false); setPendingOnly(false); setPlan(next); setDraft(next.confirmed ? null : next.entries);
      setSystem(next.confirmed ? next.system_id : initialSystem);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => { mounted.current = false; controller.abort(); };
  }, [endpoint, initialSystem, reload]);

  const confirmed = Boolean(plan?.confirmed);
  useEffect(() => {
    if (!confirmed) return;
    const controller = new AbortController();
    let timer: number;
    async function poll() {
      let delay = 6000;
      try {
        const {job:latest} = await api<{job:BookJob|null}>(endpoint+'?job=latest', {signal:controller.signal});
        if (controller.signal.aborted) return;
        if (!active.current) {
          if (pendingStart.current) {
            const pending = pendingStart.current;
            const sameScope = pending.entryId ? latest?.scope === 'chapter' && latest.entry_id === pending.entryId : latest?.scope === 'all';
            if (!latest || !sameScope || (latest.id === pending.previousId && latest.status === 'done')) {
              setError('未查到此次提交的新任务，可以再次点击生成。');
            }
            pendingStart.current = null;
          }
          setJob(latest);
          if (latest && latest.plan_version > planVersion.current) {
            const updated = await api<Plan>(endpoint, {signal:controller.signal});
            if (controller.signal.aborted) return;
            if (updated.version > planVersion.current) {
              planVersion.current = updated.version;
              setPlan(updated);
              const count = updated.entries.filter(e=>e.wiki_id).length;
              if (count !== savedCount.current) refreshRef.current();
              savedCount.current = count;
            }
          }
          setSyncError(''); setCheckedJob(true);
        }
        if (latest?.status === 'queued' || latest?.status === 'running') delay = 1800;
      } catch {
        if (!controller.signal.aborted) setSyncError('暂时无法读取任务进度，正在重新连接…');
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, delay);
      }
    }
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [endpoint, confirmed, pollEpoch]);
  const entries = draft ?? plan?.entries ?? [];
  const done = entries.filter(e => e.wiki_id).length;
  function failed(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && e.status === 409) setStale(true);
  }
  function edit(i: number, change: Partial<Entry>) {
    setDirty(true);
    setDraft(entries.map((e,n) => n === i ? {...e, ...('reuse_id' in change ? {} : {origin:'manual', edited:true}), ...change} : e));
  }
  function insert(i: number, first: number, level: Entry['level']) {
    const entry: Entry = {id:crypto.randomUUID(), title:'', first, level, last:first, origin:'manual', edited:true, uncertain:true};
    setPendingOnly(false); setDirty(true);
    setDraft([...entries.slice(0,i), entry, ...entries.slice(i)]);
  }
  async function update(action:'detect'|'confirm', useRange=false) {
    if (!plan || active.current) return;
    active.current = true; setBusy(action); setError('');
    try {
      const next = await post<Plan>(endpoint,{action, version:plan.version, ...(useRange && {toc_first:Number(tocFirst),toc_last:Number(tocLast)}), ...(action === 'confirm' && {
        system_id:system, entries:entries.map(({id,title,first,level,reuse_id,origin,uncertain,toc_page,edited}) => ({id,title:title.trim(),first,level,reuse_id,origin,uncertain:edited ? false : uncertain,toc_page}))
      })});
      if (!mounted.current) return;
      setPendingOnly(false); setDirty(false);
      if (action === 'confirm') {
        planVersion.current = next.version; setPlan(next); setDraft(null); setSystem(next.system_id);
      } else {
        setDraft(next.entries);
        setRangeOpen(false);
      }
    } catch(e) { if(mounted.current) failed(e); }
    finally { active.current = false; if(mounted.current) setBusy(''); }
  }
  async function controlJob(action:'start'|'resume_job'|'pause_job', entryId?:string) {
    if (!plan || active.current) return;
    active.current = true; setBusy(action); setError('');
    try {
      const {job:next} = await post<{job:BookJob}>(endpoint, {action, version:plan.version,
        ...(action === 'start' ? {entry_id:entryId} : {job_id:job?.id})});
      if (mounted.current) {setJob(next); setSyncError('');}
    } catch (err) {
      if (!mounted.current) return;
      if (!(err instanceof ApiError) || err.status >= 500) {
        if (action === 'start') pendingStart.current = {entryId, previousId:job?.id};
        setSyncError('请求状态待确认，正在重新读取后台进度…');
        setCheckedJob(false);
      } else { failed(err); }
    } finally {
      active.current = false;
      if (mounted.current) {setBusy(''); setPollEpoch(epoch=>epoch+1);}
    }
  }
  const close = onClose;
  const jobEntry = entries.find(entry => entry.id === (job?.current_entry_id || job?.entry_id));
  const pendingCount = entries.filter(e=>e.uncertain).length;
  const rangeValid = Number.isInteger(+tocFirst) && Number.isInteger(+tocLast) && +tocFirst >= 1 && +tocFirst <= +tocLast && +tocLast <= (plan?.pages || 0);
  const invalid = entries.some((e,i) => !e.title.trim() || !Number.isInteger(e.first) || e.first < 1 || e.first > (plan?.pages ?? 0)
    || (!i && e.level !== 1) || (i>0 && e.first < entries[i-1].first));
  return <Modal title="全文导读" subtitle={title} wide onClose={close} className="book-study">
    <div className="section-heading"><h3>书籍目录</h3><div className="button-row">
      <Button variant="secondary" disabled={!!busy || pendingSystem} onClick={() => onPaper(system)}>论文精读</Button>
      <Button variant="ghost" disabled={!!busy} onClick={onSegmented}>按原文分段整理</Button>
      <Button variant="ghost" disabled={!!busy} onClick={onCustom}>改为自选主题</Button>
    </div></div>
    {!plan && !error && <Loading/>}
    {plan && <>
      {draft && <>
        <p className="muted small">核对章名和起始{unit}，下一章开始的位置决定本章范围。{pdf && '页码使用 PDF 文件的实际页序。'}</p>
        <WikiSystemPicker value={system} onChange={setSystem} onPending={setPendingSystem} disabled={!!busy || plan.version > 0} />
        <div className="book-options">
          <Button variant="secondary" disabled={!!busy || dirty} loading={busy==='detect'} onClick={()=>void update('detect')}>从原书提取目录</Button>
          {pdf && <Button variant="ghost" disabled={!!busy || dirty} onClick={()=>setRangeOpen(!rangeOpen)}>{rangeOpen?'收起目录页选择':'指定目录页'}</Button>}
          <label><input type="checkbox" checked={pendingOnly} onChange={e=>setPendingOnly(e.target.checked)}/> 只看待核查（{pendingCount}）</label>
        </div>
        {dirty && <p className="muted small">确认本次编辑后，可再次从原书提取目录。</p>}
        {pdf && rangeOpen && <div className="book-toc-range">
          <label>目录起始页<input type="number" min={1} max={plan.pages} value={tocFirst} onChange={e=>setTocFirst(e.target.value)} /></label>
          <label>目录结束页<input type="number" min={1} max={plan.pages} value={tocLast} onChange={e=>setTocLast(e.target.value)} /></label>
          <Button variant="secondary" disabled={!!busy || dirty || !rangeValid} onClick={()=>void update('detect',true)}>提取指定页目录</Button>
        </div>}
        {pendingOnly && !pendingCount && <p className="muted small">目录中没有待核查项。</p>}
      </>}
      {!draft && <><div className="book-options"><span role="status">已整理 {done} / {entries.length} 个章节</span>
        <Button variant="secondary" disabled={!!busy || !checkedJob || jobWorking || !!syncError || stale} onClick={()=>setDraft(plan.entries)}>调整目录</Button></div>
        <Progress value={entries.length ? 100*done/entries.length : 0}/></>}
      {!draft && job && <section className="book-job-status" aria-label="后台生成任务">
        <div role="status"><strong>{job.scope === 'all' ? '全书整理' : '章节导读'} · {jobLabels[job.status]}</strong>
          {jobEntry && <span>{jobEntry.title}</span>}</div>
        {jobWorking && <p className="small muted">关闭窗口后继续生成。{job.pause_requested ? '当前批次完成后暂停。' : ''}</p>}
        {job.status !== 'done' && jobEntry && <p className="small muted">本章节已保存 {job.processed || 0} 个原文片段</p>}
        {job.status === 'failed' && <ErrorBox message={job.error || '本次生成失败，请从已保存进度继续。'} />}
        {jobWorking && <Button variant="secondary" disabled={!!busy || !!job.pause_requested} onClick={()=>void controlJob('pause_job')}>完成本批后暂停</Button>}
        {(job.status === 'paused' || job.status === 'failed') && <Button variant="secondary" disabled={!!busy || !!syncError} onClick={()=>void controlJob('resume_job')}>从已保存进度继续</Button>}
      </section>}
      {!draft && syncError && <p role="status" className="muted small">{syncError}</p>}
      <ol className="book-entries" aria-label="书籍章节目录">{entries.map((entry,i) => {
        if (draft && pendingOnly && !entry.uncertain) return null;
        const last = draft ? endPage(entries,i,plan.pages) : entry.last;
        const range = '第 '+entry.first+(last>entry.first?'–'+last:'')+' '+unit;
        const href = pdf ? '/api/sources/'+sourceId+'/file#page='+entry.first : '#/library/'+sourceId+(entry.chunk_id?'?chunk='+entry.chunk_id:'');
        return <li key={entry.id || i} className={entry.level===3?'book-subsubsection':entry.level===2?'book-subsection':''}>
          {draft ? <div className="book-entry-fields">
            <select aria-label={'目录层级 '+(i+1)} value={entry.level} disabled={!!busy} onChange={e=>edit(i,{level:Number(e.target.value) as Entry['level']})}><option value={1}>章</option><option value={2}>节</option><option value={3}>小节</option></select>
            <input aria-label={'目录标题 '+(i+1)} maxLength={200} placeholder="章节名称" value={entry.title} disabled={!!busy} onChange={e=>edit(i,{title:e.target.value})}/>
            <label>起始{unit}<input type="number" aria-label={'起始'+unit+' '+(i+1)} min={1} max={plan.pages} value={entry.first || ''} disabled={!!busy} onChange={e=>edit(i,{first:Number(e.target.value)})}/></label>
          </div> : <div className="book-entry-title">{entry.wiki_id ? <a href={'#/wiki/'+entry.wiki_id} onClick={close}>{entry.title}</a> : <strong>{entry.title}</strong>}
            {!entry.wiki_id && <Button variant="secondary" disabled={!canStart || !plan.configured} onClick={()=>void controlJob('start', entry.id)}>{entry.processed ? '继续本章整理' : entry.level===1?'试生成本章':'生成本节'}</Button>}
          </div>}
          <div className="book-entry-tools">
            {entry.origin && <small>{origins[entry.origin] || entry.origin}</small>}
            {pdf && !!entry.toc_page && <a href={'/api/sources/'+sourceId+'/file#page='+entry.toc_page} target="_blank" rel="noreferrer">目录原页 {entry.toc_page}</a>}
            <a href={href} target="_blank" rel="noreferrer">{range} · 查看原文</a>
            {draft && entry.uncertain && <><small>边界待核对</small><button type="button" disabled={!!busy} onClick={()=>edit(i,{uncertain:false})}>已核查此项</button></>}
            {draft && <><button type="button" disabled={!!busy} onClick={()=>insert(i+1, Math.min(plan.pages, entry.first+1), entry.level)}>在此拆分</button>
              {i>0 && <button type="button" disabled={!!busy} onClick={()=>{setDirty(true);setDraft(entries.filter((_,n)=>n!==i));}}>并入上一项</button>}</>}
            {!draft && !entry.wiki_id && !!entry.processed && <small>已处理 {entry.processed} 个原文片段</small>}
          </div>
          {!!entry.matched?.length && <div className="book-matches">
            <details><summary>章内已有 Wiki · {entry.matched.length}</summary>{entry.matched.map(w=><a key={w.id} href={'#/wiki/'+w.id} target="_blank" rel="noreferrer">{w.title}</a>)}</details>
            {draft && <label>选用已有 Wiki<select aria-label={'选用已有 Wiki '+(i+1)} disabled={!!busy} value={entry.reuse_id || ''} onChange={e=>edit(i,{reuse_id:e.target.value || undefined})}><option value="">独立生成章节导读</option>{entry.matched.map(w=><option key={w.id} value={w.id}>{w.title}</option>)}</select></label>}
          </div>}
          {!!entry.crossing?.length && <details className="book-matches"><summary>跨越章节边界 · 建议核对 {entry.crossing.length} 篇</summary>{entry.crossing.map(w=><a key={w.id} href={'#/wiki/'+w.id} target="_blank" rel="noreferrer">{w.title}</a>)}</details>}
        </li>;
      })}</ol>
      {draft && <Button variant="secondary" disabled={!!busy} onClick={()=>insert(entries.length,Math.min(plan.pages,(entries.at(-1)?.first ?? 0)+1),1)}>添加章节</Button>}
      {invalid && draft && <p className="muted small">请填写各章名称和有效起始{unit}，按原文顺序排列，检查章、节、小节的层级。多个条目可以同{unit}开始。</p>}
      {!plan.configured && <Notice>连接 AI 模型后即可生成章节导读。</Notice>}
    </>}
    {error && <ErrorBox message={error}/>}
    {(stale || !plan && error) && <Button variant="secondary" onClick={()=>setReload(n=>n+1)}>重新读取目录</Button>}
    <div className="form-footer"><Button variant="secondary" onClick={close}>关闭</Button>
      {draft && plan?.confirmed && <Button variant="ghost" disabled={!!busy} onClick={()=>{setDraft(null); setDirty(false); setPendingOnly(false); setRangeOpen(false); setSystem(plan.system_id);}}>取消调整</Button>}
      {draft ? <Button disabled={!entries.length || !!busy || pendingSystem || invalid || stale} loading={busy==='confirm'} onClick={()=>void update('confirm')}>确认目录</Button>
        : plan && done < entries.length && <Button disabled={!canStart || !plan.configured} onClick={()=>void controlJob('start')}>整理全书剩余章节</Button>}
    </div>
  </Modal>;
}
