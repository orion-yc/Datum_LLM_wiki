import { useEffect, useState } from 'react';
import { Check, RotateCw, Sparkles, X } from 'lucide-react';
import { post, useData } from '../api';
import { Badge, Button, ErrorBox, Field, Modal, Notice, Progress, RichText, useApp } from '../ui';
import type { PdfParseJob, Settings, Source } from '../types';

const STATUS: Record<PdfParseJob['status'], string> = {
  queued: '排队中', running: '正在逐页解析', ready: '待核对采用', applied: '已采用',
  failed: '解析未完成', cancelled: '已取消',
};

export default function PdfParsing({ source }: { source: Source }) {
  const { canEdit } = useApp();
  const [open, setOpen] = useState(false);
  const job = source.ai_parse?.id ? source.ai_parse : null;
  return <><section className="panel pdf-parse-panel">
    <div className="section-heading"><div><h3><Sparkles size={17} />PDF 版面解析</h3>
      <p className="muted small">{source.ai_pages ? `已采用 AI 解析的页面：${source.ai_pages} 页。` : source.status === 'failed' ? '普通解析未得到可用正文。' : '普通解析按阅读顺序提取正文。'} 双栏、三栏、表格或扫描页可按需使用 AI。</p></div>
      {job && <Badge tone={job.status === 'failed' ? 'orange' : job.status === 'applied' ? 'mint' : 'purple'}>{STATUS[job.status]}</Badge>}
    </div>
    <div className="button-row">{(canEdit || job) && <Button variant="secondary" onClick={() => setOpen(true)}><Sparkles size={15} />{job && ['queued', 'running', 'ready'].includes(job.status) ? '查看 AI 解析' : 'AI 版面解析'}</Button>}
      {job && ['queued', 'running'].includes(job.status) && <span className="muted small">已完成 {job.completed_pages} / {job.last_page - job.first_page + 1} 页 · 关闭页面后继续处理</span>}
    </div>
  </section>{open && <PdfParseDialog source={source} onClose={() => setOpen(false)} />}</>;
}

function PdfParseDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const { canEdit, refresh, notify } = useApp();
  const path = `/api/sources/${source.id}/ai-parse`;
  const { data, error: loadError, setData } = useData<PdfParseJob>(path, 0, 1500);
  const { data: settings } = useData<Settings>('/api/settings');
  const job = data?.id ? data : null;
  const [first, setFirst] = useState(1), [last, setLast] = useState(Math.min(source.pages || 10, 10));
  const [pageNumber, setPageNumber] = useState(0), [editing, setEditing] = useState(false);
  const [corrections, setCorrections] = useState<Record<number, string>>({});
  useEffect(() => { setCorrections({}); setPageNumber(0); setEditing(false); }, [job?.id]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = job && ['queued', 'running'].includes(job.status);
  const awaitingReview = job?.status === 'ready';
  const page = job?.pages?.find(page => page.page === pageNumber) || job?.pages?.[0];
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal title="AI 版面解析" subtitle="逐页恢复论文的阅读顺序，先与原始 PDF 对照，再决定是否采用。" className="pdf-parse-modal" wide onClose={() => { if (!busy) onClose(); }}>
    <Notice>所选页面图片会发送到空间配置的模型服务，可能产生模型费用。需要支持图片输入的模型；可在空间设置中指定 PDF 视觉模型。AI 可能误读公式、数字或表格，请保留原始 PDF 并核对。</Notice>
    {job && <div className="pdf-parse-status"><div className="section-heading"><strong>{STATUS[job.status]} · 第 {job.first_page}–{job.last_page} 页</strong><small>{job.model}</small></div>
      <Progress value={Math.round(job.completed_pages / Math.max(1, job.last_page - job.first_page + 1) * 100)} />
      <p className="muted small">已完成 {job.completed_pages} / {job.last_page - job.first_page + 1} 页。结果未采用前，现有阅读正文与检索保持原样。</p>
      {job.error && <ErrorBox message={job.error} />}
    </div>}
    {(loadError || error) && <ErrorBox message={error || loadError} />}
    {page && <><div className="pdf-parse-review-toolbar"><Field label="查看解析页"><select value={page.page} onChange={e => setPageNumber(Number(e.target.value))}>{job?.pages?.map(p => <option value={p.page} key={p.page}>第 {p.page} 页</option>)}</select></Field>
      {awaitingReview && canEdit && <label className="check-label"><input type="checkbox" checked={editing} onChange={e => setEditing(e.target.checked)} />编辑校对正文</label>}</div>
      {!!page.warnings.length && <Notice>本页需要留意：{page.warnings.join('；')}</Notice>}
      <div className="pdf-parse-review"><div><h4>原始 PDF · 第 {page.page} 页</h4><PdfPageImage key={`${job!.id}-${page.page}`} src={`${path}/${job!.id}/pages/${page.page}`} page={page.page} /><a className="text-button" href={`/api/sources/${source.id}/file#page=${page.page}`} target="_blank" rel="noreferrer">打开完整 PDF</a></div>
        <div><h4>AI 解析结果 · {awaitingReview ? '待核对' : STATUS[job!.status]}</h4>{editing && awaitingReview && canEdit ? <textarea aria-label={`第 ${page.page} 页解析正文`} rows={18} maxLength={30000} value={corrections[page.page] ?? page.content} onChange={e => setCorrections(previous => ({ ...previous, [page.page]: e.target.value }))} /> : <div className="pdf-parse-transcript"><RichText text={corrections[page.page] ?? (page.content || '本页被识别为空白页，请与 PDF 核对。')} /></div>}</div>
      </div></>}
    {canEdit && !pending && !awaitingReview && <form onSubmit={e => { e.preventDefault(); void run(async () => {
      const created = await post<PdfParseJob>(path, { firstPage: first, lastPage: last });
      setData({ ...created, pages: [] }); setCorrections({}); setPageNumber(0); setEditing(false);
      notify('AI 解析已排队，可关闭窗口，稍后回来核对结果。');
    }); }}>
      <div className="form-columns"><Field label="起始页"><input type="number" required min={1} max={source.pages || 2000} value={first} onChange={e => setFirst(Number(e.target.value))} /></Field>
        <Field label="结束页" hint="每次最多 50 页，可先解析少量页面确认效果。"><input type="number" required min={first} max={Math.min(source.pages || 2000, first + 49)} value={last} onChange={e => setLast(Number(e.target.value))} /></Field></div>
      {!settings?.configured && <Notice>请先由管理员在空间设置中连接支持图片输入的模型。</Notice>}
      <div className="form-footer"><Button loading={busy} disabled={!settings?.configured} type="submit"><RotateCw size={15} />{job?.status === 'failed' ? '重新发起 AI 解析' : '开始 AI 解析'}</Button></div>
    </form>}
    <div className="form-footer"><Button variant="secondary" disabled={busy} onClick={onClose}>关闭</Button>
      {canEdit && job && ['queued', 'running', 'ready', 'failed'].includes(job.status) && <Button variant="secondary" loading={busy} onClick={() => void run(async () => {
        const result = await post<PdfParseJob>(`${path}/${job.id}/cancel`); setData({ ...result, pages: job.pages });
      })}><X size={15} />{pending ? '取消解析' : '放弃本次结果'}</Button>}
      {canEdit && awaitingReview && <Button loading={busy} onClick={() => void run(async () => {
        await post(`${path}/${job!.id}/apply`, { corrections: Object.entries(corrections).map(([page, content]) => ({ page: Number(page), content })) });
        refresh(); notify('已采用校对结果，所选页的新正文将用于阅读、检索与后续知识生成。历史引用继续保留。'); onClose();
      })}><Check size={15} />已核对，采用所选页解析</Button>}
    </div>
  </Modal>;
}

function PdfPageImage({ src, page }: { src: string; page: number }) {
  const [failed, setFailed] = useState(false);
  return failed ? <Notice>页面预览已清理，可打开完整 PDF 核对。</Notice> : <div className="pdf-original-image"><img src={src} alt={`原始 PDF 第 ${page} 页`} onError={() => setFailed(true)} /></div>;
}
