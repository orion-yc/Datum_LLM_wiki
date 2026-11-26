import { useEffect, useRef, useState } from 'react';
import { Check, RotateCw, Sparkles, X } from 'lucide-react';
import { api, post, useData } from '../api';
import { Badge, Button, ErrorBox, Field, Modal, Notice, Progress, RichText, useApp } from '../ui';
import { OriginalPageLink, PdfFigures } from './PdfFigures';
import type { PdfParseJob, Settings, Source } from '../types';

const STATUS: Record<PdfParseJob['status'], string> = {
  paused: '已暂停', queued: '排队中', running: '正在逐页解析', ready: '待核查采用', applied: '已采用',
  failed: '解析未完成', cancelled: '已停止',
};
type ParsePage = NonNullable<PdfParseJob['pages']>[number];
export default function PdfParsing({ source }: { source: Source }) {
  const { canEdit, refresh } = useApp();
  const [open, setOpen] = useState(false);
  const job = source.ai_parse?.id ? source.ai_parse : null;
  return <><section className="panel pdf-parse-panel">
    <div className="section-heading"><div><h3><Sparkles size={17} />PDF 版面解析</h3>
      <p className="muted small">{source.ai_pages ? `已采用 AI 解析：${source.ai_pages} 页。` : '逐页恢复阅读顺序。'} 增量解析默认复用已有结果，只处理缺失页面。</p></div>
      {job && <Badge tone={job.status === 'failed' ? 'orange' : job.status === 'applied' ? 'mint' : 'purple'}>{STATUS[job.status]}</Badge>}
    </div>
    <div className="button-row">{(canEdit || job) && <Button variant="secondary" onClick={() => setOpen(true)}><Sparkles size={15} />{job && ['queued', 'running', 'paused', 'ready'].includes(job.status) ? '查看 AI 解析' : 'AI 版面解析'}</Button>}
      {job && ['queued', 'running'].includes(job.status) && <span className="muted small">已完成 {job.completed_pages} / {job.last_page - job.first_page + 1} 页 · 关闭页面后继续处理</span>}
    </div>
  </section>{open && <PdfParseDialog source={source} onClose={() => { setOpen(false); refresh(); }} />}</>;
}

function PdfParseDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const { canEdit, notify } = useApp();
  const path = `/api/sources/${source.id}/ai-parse`;
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const { data, error: loadError, setData } = useData<PdfParseJob>(`${path}?offset=${offset}`, revision, 5000);
  const { data: settings } = useData<Settings>('/api/settings');
  const job = data?.id ? data : null;
  const [scope, setScope] = useState('all'), [force, setForce] = useState(false);
  const [first, setFirst] = useState(1), [last, setLast] = useState(Math.min(source.pages || 10, 10));
  const [pageNumber, setPageNumber] = useState(0), [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ job: string; page: number; version: number; content: string } | null>(null);
  const [reviewFirst, setReviewFirst] = useState(1), [reviewLast, setReviewLast] = useState(source.pages || 10);
  const [jump, setJump] = useState(1);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [operation, setOperation] = useState('');
  const operationLock = useRef(false);
  const page = job?.pages?.find(p => p.page === pageNumber) || job?.pages?.[0];
  const pending = !!job && ['queued', 'running'].includes(job.status);
  const editable = canEdit && job?.status !== 'cancelled' && page && !page.applied;
  useEffect(() => { setEditing(false); }, [page?.page]);
  const run = async (action: () => Promise<void>) => {
    if (operationLock.current) return;
    operationLock.current = true; setBusy(true); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { operationLock.current = false; setBusy(false); }
  };
  const reload = async () => { const next = await api<PdfParseJob>(`${path}?offset=${offset}`); setData(next); return next; };
  const save = async (reviewed?: boolean) => {
    if ((!job || !page) && !draft) return;
    if (page?.applied && !draft) return;
    if (!draft && reviewed === undefined) return;
    const result = await post<ParsePage>(`${path}/${draft?.job ?? job!.id}/review`, {
      page: draft?.page ?? page!.page, version: draft?.version ?? page!.version,
      ...(draft ? { content: draft.content } : {}), reviewed: reviewed ?? false,
    });
    setDraft(null);
    setData(previous => previous ? { ...previous, pages: previous.pages?.map(p => p.page === result.page ? result : p) } : previous);
    return result;
  };
  const switchPage = async (number: number) => { await save(); setPageNumber(number); };
  const adopt = async (onlyCurrent: boolean) => {
    const saved = await save(onlyCurrent ? true : undefined);
    const latest = await reload();
    const list = onlyCurrent && page ? [{ page: page.page, version: saved?.version ?? page.version! }] : latest.review_index || [];
    if (!list.length) throw new Error('请先核查页面，再采用。');
    let applied = 0;
    try {
      for (let start = 0; start < list.length; start += 50) {
        const batch = list.slice(start, start + 50);
        setOperation(`正在采用 ${applied} / ${list.length} 页…`);
        await post(`${path}/${latest.id}/apply`, { pages: batch.map(p => p.page), requireReviewed: true, versions: Object.fromEntries(batch.map(p => [p.page, p.version])) });
        applied += batch.length;
      }
    } catch (e) { throw new Error(`已采用 ${applied} / ${list.length} 页；此前成功结果已保留。${(e as Error).message}`); }
    finally { setOperation(''); await reload(); }
    notify(`已采用 ${applied} 页。未采用页面继续保留。`);
  };
  return <Modal title="AI 版面解析" subtitle="增量处理缺页，核查记录逐页保存；可以核查一页，也可以采用跨列表的已核查结果。" className="pdf-parse-modal" wide onClose={() => { if (!busy) void run(async () => { await save(); onClose(); }); }}>
    <Notice>页面图片将发送至模型服务并可能产生费用。默认复用已有解析及校对结果；只有勾选重新解析才重复调用。公式、数字和表格仍需与 PDF 核对。</Notice>
    {job && <div className="pdf-parse-status"><div className="section-heading"><strong>{STATUS[job.status]} · 第 {job.first_page}–{job.last_page} 页</strong><small>{job.model}</small></div>
      <Progress value={Math.round(job.completed_pages / Math.max(1, job.last_page - job.first_page + 1) * 100)} />
      <p className="muted small">成功 / 复用 {job.completed_pages} 页 · 已核查 {job.reviewed_pages || 0} 页 · 已采用 {job.applied_pages || 0} 页</p>
      {job.error && <ErrorBox message={job.error} />}
    </div>}
    {(loadError || error) && <ErrorBox message={error || loadError} />}
    {operation && <p role="status">{operation}</p>}
    {job && <div className="button-row"><Button variant="secondary" disabled={offset === 0 || busy} onClick={() => void run(async () => { await save(); setOffset(Math.max(0, offset - 50)); })}>上一批</Button><span>页面列表 {offset + 1}–{Math.min(offset + 50, job.completed_pages)}（不限制核查总数）</span><Button variant="secondary" disabled={offset + 50 >= job.completed_pages || busy} onClick={() => void run(async () => { await save(); setOffset(offset + 50); })}>下一批</Button>
      <Field label="跳到页码"><input type="number" min={job.first_page} max={job.last_page} value={jump} onChange={e => setJump(Number(e.target.value))} /></Field><Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await save(); const position = Math.max(0, jump - job.first_page); setOffset(Math.floor(position / 50) * 50); setPageNumber(jump); })}>跳转</Button>
    </div>}
    {page && <><div className="pdf-parse-review-toolbar"><Field label="查看解析页"><select disabled={busy} value={page.page} onChange={e => void run(() => switchPage(Number(e.target.value)))}>{job?.pages?.map(p => <option value={p.page} key={p.page}>第 {p.page} 页 · {p.applied ? '已采用' : p.reviewed ? '已核查' : '待核查'}</option>)}</select></Field>
      {editable && <label className="check-label"><input type="checkbox" checked={editing} disabled={busy} onChange={e => setEditing(e.target.checked)} />编辑校对正文</label>}</div>
      {page.origin_model && <p className="muted small">复用结果，原解析模型：{page.origin_model}；不会再次调用模型。</p>}
      {!!page.warnings.length && <Notice>本页需要留意：{page.warnings.join('；')}</Notice>}
      <div className="pdf-parse-review">
        <div className="pdf-review-originals"><OriginalPageLink href={`${path}/${job!.id}/pages/${page.page}`} page={page.page} /><a className="text-button" href={`/api/sources/${source.id}/file#page=${page.page}`} target="_blank" rel="noreferrer">打开完整 PDF</a></div>
        <div><h4>解析正文 · {page.applied ? '已采用' : page.reviewed && !draft ? '已核查' : '待核查'}</h4>{editing && editable ? <textarea aria-label={`第 ${page.page} 页解析正文`} rows={18} maxLength={30000} disabled={busy} value={draft?.content ?? page.content} onChange={e => setDraft({ job: job!.id, page: page.page, version: draft?.version ?? page.version!, content: e.target.value })} /> : <div className="pdf-parse-transcript"><RichText math text={draft?.content ?? (page.content || '本页识别为空白，请与 PDF 核对。')} /></div>}
          <PdfFigures showOriginal={false} key={page.page} sourceId={source.id} page={page.page} /></div>
      </div>
      <div className="pdf-page-actions" role="toolbar" aria-label="页面核查操作"><div className="pdf-page-navigation"><Button variant="secondary" disabled={busy || page.page<=job!.first_page} onClick={() => void run(async () => { await save(); const next=page.page-1; setPageNumber(next); if (!job!.pages?.some(p=>p.page===next)) setOffset(Math.max(0,offset-50)); })}>上一页</Button><Button variant="secondary" disabled={busy || page.page>=job!.first_page+job!.completed_pages-1} onClick={() => void run(async () => { await save(); const next=page.page+1; setPageNumber(next); if (!job!.pages?.some(p=>p.page===next)) setOffset(offset+50); })}>下一页</Button></div>
      {editable && <div className="pdf-page-review-actions"><Button variant="secondary" disabled={busy || !draft} onClick={() => void run(async () => { await save(); notify('校对草稿已保存，当前页待核查。'); })}>保存校对</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await save(true); await reload(); })}>标记本页已核查</Button>
        <Button disabled={busy} onClick={() => void run(() => adopt(true))}><Check size={15} />核查并采用本页</Button></div>}</div>
    </>}
    {canEdit && job && job.status !== 'cancelled' && <section className="panel"><h4>范围核查与采用</h4><p className="muted small">确认已经核查相应页面后再标记。记录跨翻页、关闭窗口和重启保留。</p>
      <div className="form-columns"><Field label="核查起始页"><input type="number" min={1} max={10000} value={reviewFirst} onChange={e => setReviewFirst(Number(e.target.value))} /></Field><Field label="核查结束页"><input type="number" min={reviewFirst} max={10000} value={reviewLast} onChange={e => setReviewLast(Number(e.target.value))} /></Field></div>
      <div className="button-row"><Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await save(); const result = await post<{updated:number}>(`${path}/${job.id}/review-range`, { firstPage: reviewFirst, lastPage: reviewLast, reviewed: true }); await reload(); notify(`已将 ${result.updated} 个完成页标为已核查。`); })}>标记范围已核查</Button>
        <Button disabled={busy || !job.review_index?.length} onClick={() => void run(() => adopt(false))}>采用全部已核查页（{job.review_index?.length || 0}）</Button></div></section>}
    {canEdit && !pending && job?.status !== 'paused' && <form onSubmit={e => { e.preventDefault(); void run(async () => {
      await save(); const created = await post<PdfParseJob>(path, { ...(scope === 'all' ? { scope: 'all' } : { firstPage: first, lastPage: last }), resumable: true, force });
      setData({ ...created, pages: [] }); setOffset(0); setPageNumber(0); setDraft(null); setRevision(v => v + 1); setForce(false); notify(force ? '已创建重新解析任务，所选范围会再次调用模型。' : '增量任务已创建，已有页将复用，只解析缺失页。');
    }); }}><Field label="解析范围"><select disabled={busy} value={scope} onChange={e => setScope(e.target.value)}><option value="all">整份 PDF（后台连续解析）</option><option value="range">指定页码范围</option></select></Field>
      {scope === 'range' && <div className="form-columns"><Field label="起始页"><input disabled={busy} type="number" required min={1} max={source.pages || 10000} value={first} onChange={e => setFirst(Number(e.target.value))} /></Field><Field label="结束页"><input disabled={busy} type="number" required min={first} max={source.pages || 10000} value={last} onChange={e => setLast(Number(e.target.value))} /></Field></div>}
      <label className="check-label"><input type="checkbox" disabled={busy} checked={force} onChange={e => setForce(e.target.checked)} />重新解析所选页（不复用，会再次调用模型）</label>
      {force && <Notice>仅对选中范围重新调用模型。原有阅读正文和历史引用保留，新结果需重新核查。</Notice>}
      <div className="form-footer"><Button loading={busy} disabled={!settings?.configured} type="submit"><RotateCw size={15} />{force ? '重新解析所选范围' : '开始增量解析'}</Button></div></form>}
    <div className="form-footer"><Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await save(); onClose(); })}>关闭</Button>
      {canEdit && job?.resumable === 1 && pending && <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await save(); await post(`${path}/${job.id}/pause`); await reload(); })}>暂停解析</Button>}
      {canEdit && job?.resumable === 1 && ['paused', 'failed'].includes(job.status) && <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await save(); await post(`${path}/${job.id}/resume`); await reload(); })}>继续未完成页面</Button>}
      {canEdit && job && ['queued','running','paused','ready','failed'].includes(job.status) && <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await save(); await post(`${path}/${job.id}/cancel`); await reload(); })}><X size={15} />{pending ? '取消解析' : '放弃本次结果'}</Button>}
    </div>
  </Modal>;
}
