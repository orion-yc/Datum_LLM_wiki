import { BookBreadcrumb, BookPageTurns, useBookPosition } from './BookReading';
import WikiRewriteDialog from './WikiRewriteDialog';
import { wikiSectionAt, type RewriteTarget } from '../wikiRewriteRange';
import WikiSelectionQuestion from './WikiSelectionQuestion';
import { MathText } from '../MathText';
import { useEffect, useRef, useState } from 'react';
import { PdfFigures } from './PdfFigures';
import WikiSystemPicker, { type SystemChoice } from './WikiSystemPicker';
import { BookDirectory, bookPageLink, type BookDirectoryData } from './BookDirectory';
import './BookHome.css';
import WholeStudy from './WholeStudy';
import { ProjectBacklinks } from './Projects';
import { ArrowLeft, ArrowUpRight, BookOpen, CheckCircle2, Download, FileText, History, Link2, Plus, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { api, navigate, post, put, remove, useData, formatDate } from '../api';
import { Badge, Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, Notice, PageTitle, RichText, useApp } from '../ui';
import { CATEGORIES, type Source, type SourceDetail, type WikiAudit, type WikiEvidence, type WikiHistory, type WikiSystem, type WikiPage } from '../types';
import { Collaboration } from './Team';

const KINDS = { concept: '概念', method: '方法与实践', overview: '主题综述' };
const blank = (): WikiPage => ({ id: '', title: '', kind: 'concept', category: '个人学习', summary: '', body: '', tags: [], status: 'draft', citations: [], related_ids: [], _version: 1, updated_at: '' });
const evidenceLink = (cite: WikiEvidence) => `/library/${cite.source_id}?chunk=${cite.chunk_id}`;

function EvidenceList({ citations, onRemove }: { citations: WikiEvidence[]; onRemove?: (index: number) => void }) {
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  return <div className="wiki-evidence">{citations.map((cite, i) => <details key={cite.chunk_id} id={`wiki-evidence-${i + 1}`} onToggle={e => {
    const open = e.currentTarget.open;
    setOpened(old => { const next = new Set(old); if (open) next.add(cite.chunk_id); else next.delete(cite.chunk_id); return next; });
  }}><summary><span className="wiki-number">{i + 1}</span><span>{cite.source_title} / {cite.heading}</span></summary>
    <p><MathText text={cite.excerpt} /></p>
    {opened.has(cite.chunk_id) && cite.type === 'pdf' && <PdfFigures sourceId={cite.source_id} page={cite.page} />}
    <div className="button-row"><a className="button ghost" href={'#' + evidenceLink(cite)} target={onRemove ? '_blank' : undefined} rel={onRemove ? 'noreferrer' : undefined}><BookOpen size={14} />打开原文{cite.type === 'pdf' ? ` · 第 ${cite.page} 页` : ''}</a>{onRemove && <Button type="button" variant="ghost" onClick={() => onRemove(i)}>移除此证据</Button>}</div>
  </details>)}</div>;
}

function EvidencePicker({ existing, onPick, onClose }: { existing: WikiEvidence[]; onPick: (cites: WikiEvidence[]) => void; onClose: () => void }) {
  const { data: sources } = useData<Source[]>('/api/sources');
  const [source, setSource] = useState(''), [query, setQuery] = useState(''), [selected, setSelected] = useState<Set<string>>(new Set(existing.map(c => c.chunk_id)));
  const { data, loading, error } = useData<SourceDetail>(source ? `/api/sources/${source}` : null);
  const candidates = data?.chunks.filter(c => (c.heading + c.content).toLowerCase().includes(query.toLowerCase())) || [];
  return <Modal title="添加知识页原文证据" subtitle="从原始资料选择片段，引用正文由服务器核对。" onClose={onClose} wide><Field label="证据来源资料"><select value={source} onChange={e => { setSource(e.target.value); setQuery(''); setSelected(new Set(existing.map(c => c.chunk_id))); }}><option value="">选择一份已解析资料</option>{sources?.filter(s => s.status === 'ready').map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></Field><Field label="筛选原文片段"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="按章节或正文关键词查找" /></Field>{error && <ErrorBox message={error} />}{source && loading && <Loading />}<div className="evidence-picker">{candidates.slice(0, 100).map(chunk => <label key={chunk.id}><input type="checkbox" checked={selected.has(chunk.id)} disabled={existing.some(c => c.chunk_id === chunk.id)} onChange={e => setSelected(old => { const next = new Set(old); if (e.target.checked) next.add(chunk.id); else next.delete(chunk.id); return next; })} /><div><strong>{chunk.heading} · 片段 {chunk.page}</strong><p><MathText text={chunk.content} /></p></div></label>)}{candidates.length > 100 && <p className="muted">显示前 100 条，请输入关键词进一步筛选。</p>}</div><div className="form-footer"><Button variant="secondary" onClick={onClose}>取消</Button><Button disabled={!data || selected.size > 32} onClick={() => { if (!data) return; const added = data.chunks.filter(c => selected.has(c.id) && !existing.some(e => e.chunk_id === c.id)).map((c, i) => ({ chunk_id: c.id, source_id: data.id, number: existing.length + i + 1, source_title: data.title, heading: c.heading, page: c.page, type: data.type, excerpt: c.content.slice(0, 1600) })); onPick([...existing, ...added]); onClose(); }}>添加选中证据（{selected.size}/32）</Button></div></Modal>;
}

function WikiEditor({ initial, initialPreview = false, onClose }: { initial: WikiPage; initialPreview?: boolean; onClose: () => void }) {
  const { refresh, notify } = useApp(); const { data: pages } = useData<WikiPage[]>('/api/wiki');
  const { data: systems } = useData<WikiSystem[]>('/api/wiki/systems');
  const [pendingSystem, setPendingSystem] = useState(false);
  const [draft, setDraft] = useState(initial), [tags, setTags] = useState(initial.tags.join('，')), [busy, setBusy] = useState(false), [error, setError] = useState(''), [picker, setPicker] = useState(false), [preview, setPreview] = useState(initialPreview), [discard, setDiscard] = useState(false), [dirty, setDirty] = useState(Boolean(initial.generation_mode));
  const [rewrite, setRewrite] = useState<RewriteTarget | null>(null);
  const [undo, setUndo] = useState<Pick<WikiPage, 'body' | 'summary'> | null>(null);
  const [cursor, setCursor] = useState({start: 0, end: 0});
  const change = (patch: Partial<WikiPage>) => {
    if ('body' in patch || 'summary' in patch) setUndo(null);
    setDraft(d => ({ ...d, ...patch })); setDirty(true);
  };
  const evidenceRef = useRef<HTMLDivElement>(null);
  function showEvidence(number: number) {
    const details = evidenceRef.current?.querySelectorAll('details')[number - 1];
    if (details) { details.open = true; details.scrollIntoView({block:'center'}); }
  }
  const section = !preview && wikiSectionAt(draft.body, cursor.start);
  if (rewrite) return <WikiRewriteDialog page={draft} target={rewrite} onClose={() => setRewrite(null)} onApply={value => {
    setUndo({ body: draft.body, summary: draft.summary });
    setDraft(d => ({ ...d, ...value })); setDirty(true);
    setCursor({start: 0, end: 0}); setRewrite(null);
  }} />;
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose(); };
  return <Modal title={draft.id ? '编辑 Wiki 知识页' : '整理 Wiki 知识页草稿'} subtitle="保存草稿后核对引用，再发布到可用于辅助问答的知识层。" onClose={close} wide><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { const body = { ...draft, tags: tags.split(/[,，]/).map(t => t.trim()).filter(Boolean) }; const result = draft.id ? await put<WikiPage>(`/api/wiki/${draft.id}`, body) : await post<WikiPage>('/api/wiki', body); refresh(); notify('知识页草稿已保存。'); onClose(); navigate(`/wiki/${result.id}`); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
    {draft.generation_mode && <Notice>{draft.generation_mode === 'model' ? '模型已基于所选片段生成草稿。请核对结论与每一处引用。' : '当前未配置模型，以下是原文摘录草稿。可以自行整理后发布。'}<div className="wiki-coverage">{draft.coverage?.map(c => <span key={c.source_id}>{c.title}：使用 {c.used_chunks}/{c.total_chunks} 个片段</span>)}</div></Notice>}
    <Field label="知识页标题"><input required maxLength={200} value={draft.title} onChange={e => change({ title: e.target.value })} /></Field><div className="form-columns"><Field label="知识页类型"><select value={draft.kind} onChange={e => change({ kind: e.target.value as WikiPage['kind'] })}>{Object.entries(KINDS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="知识页方向"><select value={draft.category} onChange={e => change({ category: e.target.value })}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></Field></div>
    <WikiSystemPicker onPending={setPendingSystem} value={draft.system_id} allowAuto={!draft.id} onChange={system_id => change({ system_id })} />
    <Field label="知识页摘要"><textarea rows={2} maxLength={2000} value={draft.summary} onChange={e => change({ summary: e.target.value })} /></Field><Field label="知识页标签" hint="用逗号分隔，最多 15 个。"><input value={tags} maxLength={1000} onChange={e => { setTags(e.target.value); setDirty(true); }} /></Field>
    <div className="section-heading"><h3>正文与引用</h3><div className="button-row wiki-rewrite-actions">
      {undo && <Button type="button" variant="ghost" onClick={() => change(undo)}>撤销上次改写</Button>}
      {!preview && cursor.end > cursor.start && <Button type="button" variant="secondary" onClick={() => setRewrite({scope:'selection', ...cursor})}>重新总结选段</Button>}
      {section && <Button type="button" variant="secondary" onClick={() => setRewrite(section)}>重写本节</Button>}
      <Button type="button" variant="secondary" disabled={!draft.body.trim()} onClick={() => setRewrite({scope:'page', start:0, end:draft.body.length})}><Sparkles size={15}/>整页重新总结</Button>
      <Button type="button" variant="ghost" onClick={() => setPreview(!preview)}>{preview ? '继续编辑' : '预览正文'}</Button></div></div>{preview ? <div className="wiki-preview"><WikiSelectionQuestion page={draft} onCitation={showEvidence} allowAsk={false} onRewrite={setRewrite} /></div> : <Field label="知识页正文" hint="支持 Markdown，行内公式用 $…$，独立公式用 $$…$$。关键结论后用 [1]、[2] 对应下方原文依据。"><textarea onSelect={e => setCursor({start:e.currentTarget.selectionStart, end:e.currentTarget.selectionEnd})} rows={13} maxLength={30000} value={draft.body} onChange={e => change({ body: e.target.value })} /></Field>}
    <div className="section-heading"><h3>原文依据 · {draft.citations.length}</h3><Button type="button" variant="secondary" disabled={draft.citations.length >= 32} onClick={() => setPicker(true)}><Plus size={14} />添加原文证据</Button></div><p className="muted small">移除证据后编号会顺延，请同步核对正文引用编号。</p><div ref={evidenceRef}><EvidenceList citations={draft.citations} onRemove={i => change({ citations: draft.citations.filter((_, n) => n !== i) })} /></div>
    <Field label="关联知识页" hint="按 Ctrl / Command 可多选，关联后会自动产生反向链接。"><select multiple size={Math.min(5, Math.max(2, (pages?.length || 0)))} value={draft.related_ids} onChange={e => change({ related_ids: [...e.target.selectedOptions].map(o => o.value) })}>{[...(systems || []), { id: '', title: '待归类' }].map(system => {
      const candidates = pages?.filter(p => p.id !== draft.id && (p.system_id || '') === system.id);
      return candidates?.length ? <optgroup key={system.id} label={system.title}>{candidates.map(p => <option key={p.id} value={p.id}>{p.title}{p.status === 'draft' ? '（草稿）' : ''}</option>)}</optgroup> : null;
    })}</select></Field>
    {error && <ErrorBox message={error} />}<div className="form-footer"><Button type="button" variant="secondary" disabled={busy} onClick={close}>取消</Button><Button disabled={pendingSystem} loading={busy}>保存知识页草稿</Button></div></form>
    {picker && <EvidencePicker existing={draft.citations} onPick={cites => change({ citations: cites })} onClose={() => setPicker(false)} />}{discard && <Confirm title="放弃尚未保存的输入？" text="可以继续编辑，或关闭此窗口。已保存的版本仍会保留。" confirmLabel="放弃输入" onClose={() => setDiscard(false)} onConfirm={async () => onClose()} />}
  </Modal>;
}

function NewWiki({ sourceId, initialSystem, onClose }: { initialSystem?: SystemChoice; sourceId?: string | null; onClose: () => void }) {
  const { data: sources } = useData<Source[]>('/api/sources'); const [selected, setSelected] = useState<string[]>(sourceId ? [sourceId] : []), [title, setTitle] = useState(''), [question, setQuestion] = useState(''), [kind, setKind] = useState<WikiPage['kind']>('concept'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [proposal, setProposal] = useState<WikiPage | null>(null);
  const [pendingSystem, setPendingSystem] = useState(false);
  const [guide, setGuide] = useState(Boolean(sourceId));
  const [systemId, setSystemId] = useState<SystemChoice>(initialSystem);
  const selectedSource = sources?.find(s => s.id === selected[0]);
  const [paper, setPaper] = useState(false);
  const paperRequest = useRef<AbortController | null>(null);
  useEffect(() => () => paperRequest.current?.abort(), []);
  async function readPaper(system: SystemChoice) {
    if (paperRequest.current || selected.length !== 1) return;
    const request = new AbortController();
    paperRequest.current = request;
    setPaper(true); setSystemId(system); setError(''); setBusy(true);
    try {
      const result = await api<WikiPage>('/api/wiki/draft', {method:'POST', signal:request.signal,
        body:JSON.stringify({mode:'paper', source_ids:selected, system_id:system})});
      if (!request.signal.aborted) setProposal({...blank(), ...result});
    } catch (err) {
      if (!request.signal.aborted) setError((err as Error).message);
    } finally {
      paperRequest.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }
  if (proposal) return <WikiEditor initial={proposal} initialPreview={paper} onClose={onClose} />;
  if (paper) return <Modal title="论文精读" subtitle={selectedSource?.title} onClose={onClose}>
    {busy && <p role="status">正在结合论文原文撰写中文导读…</p>}
    {error && <ErrorBox message={error} retry={() => void readPaper(systemId)} />}
    <div className="form-footer"><Button variant="secondary" onClick={onClose}>关闭</Button>
      {!busy && <Button variant="ghost" onClick={() => {setPaper(false); setError('');}}>返回整理方式</Button>}</div>
  </Modal>;
  if (guide && selected.length === 1) return <WholeStudy initialSystem={systemId} key={selected[0]} sourceId={selected[0]} title={selectedSource?.title} pdf={selectedSource?.type === 'pdf'} onClose={onClose} onCustom={() => setGuide(false)} onPaper={readPaper} />;
  return <Modal title="从资料整理 Wiki" subtitle="围绕一个主题，选择 1 至 8 份原文资料。" onClose={() => { if (!busy) onClose(); }} wide>{selected.length === 1 && <div className="form-footer"><Button variant="secondary" disabled={busy || pendingSystem} onClick={() => setGuide(true)}><BookOpen size={15} />按书籍目录整理</Button><Button variant="secondary" disabled={busy || pendingSystem} onClick={() => void readPaper(systemId)}>论文精读</Button></div>}<form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { const result = await post<WikiPage>('/api/wiki/draft', { title, question, kind, system_id: systemId, source_ids: selected }); setProposal({ ...blank(), ...result }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Field label="整理主题"><input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：二分查找的边界处理与适用条件" /></Field><Field label="希望解决的问题"><textarea maxLength={2000} rows={2} value={question} onChange={e => setQuestion(e.target.value)} placeholder="哪些概念需要串联？哪些方法需要比较？" /></Field><WikiSystemPicker onPending={setPendingSystem} value={systemId} onChange={setSystemId} disabled={busy} /><Field label="整理类型"><select value={kind} onChange={e => setKind(e.target.value as WikiPage['kind'])}>{Object.entries(KINDS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field><div className="wiki-source-picker">{sources?.filter(s => s.status === 'ready').map(s => <label key={s.id}><input type="checkbox" checked={selected.includes(s.id)} disabled={!selected.includes(s.id) && selected.length >= 8} onChange={e => setSelected(old => e.target.checked ? [...old, s.id] : old.filter(id => id !== s.id))} /><span><strong>{s.title}</strong><small>{s.category} · {s.pages} 页或片段</small></span></label>)}{!sources?.some(s => s.status === 'ready') && <p className="muted">请先在资料库上传并解析原文资料。</p>}</div><Notice>系统会按主题检索，并从每份资料抽取分布在不同位置的片段，生成后会显示使用范围。草稿需保存并核对后才能发布。</Notice>{error && <ErrorBox message={error} />}<div className="form-footer"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button disabled={!selected.length || pendingSystem} loading={busy}><Sparkles size={15} />生成可编辑草稿</Button></div></form></Modal>;
}

function WikiHistoryDialog({ page, onClose }: { page: WikiPage; onClose: () => void }) {
  const { refresh, notify, canEdit, isAdmin } = useApp(); const { data, error, loading } = useData<WikiHistory[]>(`/api/wiki/${page.id}/history`);
  const [selected, setSelected] = useState<WikiHistory | null>(null), [restore, setRestore] = useState<WikiHistory | null>(null);
  return <Modal title="知识页版本记录" subtitle="每次保存、发布和恢复都有独立快照。恢复会创建新的草稿版本。" onClose={onClose} wide>{error && <ErrorBox message={error} />}{loading && <Loading />}<div className="history-list">{data?.map(h => <div key={h.id}><Button variant="ghost" onClick={() => setSelected(h)}>v{h.version} · {h.author_name} · {new Date(h.created_at).toLocaleString('zh-CN')}</Button>{canEdit && (page.status === 'draft' || isAdmin) && <Button variant="secondary" onClick={() => setRestore(h)}>恢复为新草稿</Button>}</div>)}</div>{selected && <div className="history-preview"><h3>v{selected.version} · {selected.snapshot.title}</h3><RichText math text={selected.snapshot.body} /><EvidenceList citations={selected.snapshot.citations} /></div>}{restore && <Confirm title={`恢复知识页 v${restore.version}？`} text="将所选快照恢复为新草稿；如果其中的原文或关联页已被删除，恢复会提示缺失内容。" confirmLabel="恢复知识页版本" onClose={() => setRestore(null)} onConfirm={async () => { await post(`/api/wiki/${page.id}/restore`, { _version: page._version, history_id: restore.id }); refresh(); notify('历史内容已恢复为新草稿。'); onClose(); }} />}</Modal>;
}

function WikiDetail({ id }: { id: string }) {
  const { revision, refresh, notify, canEdit, isAdmin } = useApp(); const { data: page, loading, error } = useData<WikiPage>(`/api/wiki/${id}`, revision);
  const { data: systems } = useData<WikiSystem[]>('/api/wiki/systems', revision);
  const position = useBookPosition(id, page?.system_id);
  const systemTitle = (systemId?: string | null) => !systemId ? '待归类' : systems?.find(s => s.id === systemId)?.title || '知识体系';
  const [edit, setEdit] = useState(false), [history, setHistory] = useState(false), [transition, setTransition] = useState<'draft' | 'published' | null>(null), [deleting, setDeleting] = useState(false), [busy, setBusy] = useState(false);
  const [rewrite, setRewrite] = useState<{ page: WikiPage; target: RewriteTarget } | null>(null);
  const [undo, setUndo] = useState<{version: number; body: string; summary: string} | null>(null);
  if (error) return <ErrorBox message={error} retry={refresh} />; if (loading || !page) return <Loading />;
  const cite = (number: number) => { const element = document.getElementById(`wiki-evidence-${number}`) as HTMLDetailsElement | null; if (element) { element.open = true; element.scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
  return <>{position ? <BookBreadcrumb position={position} /> : <button className="back-link" onClick={() => navigate(`/wiki?system=${page.system_id || 'unassigned'}`)}><ArrowLeft size={15} />返回{systemTitle(page.system_id)}</button>}<PageTitle eyebrow="CONNECTED KNOWLEDGE, ORIGINAL EVIDENCE" title={<MathText text={page.title} />} description={`${systemTitle(page.system_id)} · ${page.category} · ${KINDS[page.kind]} · v${page._version} · ${formatDate(page.updated_at)}更新`} /><div className="wiki-detail-toolbar"><Badge tone={page.status === 'published' ? 'mint' : 'orange'}>{page.status === 'published' ? '已发布' : '草稿'}</Badge><div className="button-row"><Button variant="secondary" onClick={() => setHistory(true)}><History size={15} />历史版本</Button><a className="button secondary" href={`/api/wiki/${id}/export`} download><Download size={15} />导出 Markdown</a>{canEdit && page.status === 'draft' && <><Button variant="secondary" onClick={() => setEdit(true)}>编辑知识页</Button>
      <Button variant="secondary" disabled={!page.body.trim()} onClick={() => setRewrite({page, target:{scope:'page', start:0, end:page.body.length}})}><Sparkles size={15}/>整页重新总结</Button>
      {undo?.version === page._version && <Button variant="ghost" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          await put(`/api/wiki/${id}`, {...page, body:undo.body, summary:undo.summary});
          setUndo(null); refresh(); notify('已撤销上次改写。');
        } catch (e) { notify((e as Error).message, 'error'); } finally { setBusy(false); }
      }}>撤销上次改写</Button>}
      <Button onClick={() => setTransition('published')}><CheckCircle2 size={15} />核对并发布</Button></>}{isAdmin && page.status === 'published' && <Button variant="secondary" onClick={() => setTransition('draft')}>转为草稿</Button>}{canEdit && (page.status === 'draft' || isAdmin) && <Button variant="ghost" onClick={() => setDeleting(true)}>删除知识页</Button>}</div></div>
  <ProjectBacklinks type="wiki" id={id} />
    {page.status === 'draft' && <Notice>此页正在整理。发布后，它会帮助问答定位原文；请核对关键结论与证据编号。</Notice>}<div className="wiki-detail-grid"><article className="panel wiki-article">{page.summary && <p className="wiki-summary"><MathText text={page.summary} /></p>}<div className="wiki-tags">{page.tags.map(tag => <Badge key={tag} tone="gray">{tag}</Badge>)}</div><WikiSelectionQuestion key={page.id} page={page} onCitation={cite} onRewrite={canEdit && page.status === 'draft' ? target => setRewrite({page, target}) : undefined} />{position && <BookPageTurns position={position} />}<div className="wiki-article-evidence"><h2><BookOpen size={19} />原文依据 · {page.citations.length}</h2><EvidenceList citations={page.citations} /></div></article><aside className="wiki-side"><section className="panel"><h3><Link2 size={16} />关联知识页</h3>{page.related?.map(p => <button className="wiki-link" key={p.id} onClick={() => navigate(`/wiki/${p.id}`)}><span>{p.title}{p.system_id !== page.system_id && <small className="system-origin">{systemTitle(p.system_id)}</small>}</span><ArrowUpRight size={14} /></button>)}{!page.related?.length && <p className="muted small">编辑时关联相邻概念、前置方法或主题综述。</p>}</section><section className="panel"><h3><Link2 size={16} />哪些页面提到了我</h3>{page.backlinks?.map(p => <button className="wiki-link" key={p.id} onClick={() => navigate(`/wiki/${p.id}`)}><span>{p.title}{p.system_id !== page.system_id && <small className="system-origin">{systemTitle(p.system_id)}</small>}</span><ArrowUpRight size={14} /></button>)}{!page.backlinks?.length && <p className="muted small">还没有其他知识页关联此页。</p>}</section><section className="panel"><h3><ShieldCheck size={16} />知识的来处</h3><p className="muted small">引用内容由服务端读取原文。发布状态表示成员已核对，仍需结合适用条件理解。</p><Button write variant="ghost" disabled={busy} onClick={async () => { setBusy(true); try { const conversation = await post('/api/conversations'); refresh(); navigate(`/chat/${conversation.id}`); } catch (e) { notify((e as Error).message, 'error'); } finally { setBusy(false); } }}>带着问题去对话<ArrowUpRight size={14} /></Button></section></aside></div><Collaboration kind="wiki" targetId={id} />
    {rewrite && <WikiRewriteDialog page={rewrite.page} target={rewrite.target} onClose={() => setRewrite(null)} onApply={async value => {
      const saved = await put<WikiPage>(`/api/wiki/${id}`, {...rewrite.page, ...value});
      setUndo({version:saved._version, body:rewrite.page.body, summary:rewrite.page.summary});
      setRewrite(null); refresh(); notify('改写已保存为新的草稿版本。');
    }} />}
    {edit && <WikiEditor initial={page} onClose={() => setEdit(false)} />}{history && <WikiHistoryDialog page={page} onClose={() => setHistory(false)} />}{transition && <Confirm title={transition === 'published' ? '确认核对并发布知识页？' : '将知识页转为草稿？'} text={transition === 'published' ? '请确认结论与原文相符、引用编号正确，且相关讨论已经解决。发布后正文会锁定，管理员可以重新开放编辑。' : '该页将停止辅助问答检索，现有历史记录会保留。'} confirmLabel={transition === 'published' ? '确认发布知识页' : '确认转为草稿'} onClose={() => setTransition(null)} onConfirm={async () => { await post(`/api/wiki/${id}/state`, { _version: page._version, status: transition }); refresh(); notify(transition === 'published' ? '知识页已发布。' : '知识页已转为草稿。'); }} />}{deleting && <Confirm title="删除这个知识页？" text="正文、历史、讨论和关联任务会删除，原始资料保留。被其他页面关联时需要先解除关联。" onClose={() => setDeleting(false)} onConfirm={async () => { await remove(`/api/wiki/${id}`); refresh(); navigate('/wiki'); }} />}
  </>;
}

function BookDirectoryPlaceholder() {
  return <div role="status" aria-label="正在加载目录" className="panel wiki-directory-placeholder">
    <span /><span /><span />
  </div>;
}

export default function Wiki({ id, sourceId, systemKey, bookKey, cardsView }: { id?: string; sourceId?: string | null; systemKey?: string | null; bookKey?: string | null; cardsView?: boolean }) {
  const { revision, refresh, canEdit, isAdmin, notify } = useApp(); const { data: pages, loading, error } = useData<WikiPage[]>('/api/wiki', revision); const { data: audit, error: auditError } = useData<WikiAudit>('/api/wiki/audit', revision);
  const [tab, setTab] = useState('pages'), [search, setSearch] = useState(''), [status, setStatus] = useState('all'), [newOpen, setNewOpen] = useState(false), [manual, setManual] = useState(false);
  const [batch, setBatch] = useState(false), [chosen, setChosen] = useState(new Set<string>());
  const [snapshot, setSnapshot] = useState<WikiPage[]>([]), [deleteError, setDeleteError] = useState(''), [deleting, setDeleting] = useState(false);
  const { data: systems, loading: systemLoading, error: systemError } = useData<{ id: string; title: string }[]>('/api/wiki/systems', revision);
  const [systemForm, setSystemForm] = useState<'new' | 'rename' | null>(null), [name, setName] = useState(''), [systemBusy, setSystemBusy] = useState(false), [systemMessage, setSystemMessage] = useState('');
  const [moving, setMoving] = useState(false), [target, setTarget] = useState('');
  const system = systems?.find(row => row.id === systemKey);
  const currentSystem = systemKey === 'unassigned' ? null : system?.id;
  const title = systemKey === 'all' ? '全部知识页' : system?.title || '待归类';
  const folders = !systemKey;
  const isNamedSystem = Boolean(systemKey && systemKey !== 'all' && systemKey !== 'unassigned');
  const {data: books, error: booksError} = useData<BookDirectoryData[]>(
    isNamedSystem && !id ? '/api/wiki/systems/' + encodeURIComponent(systemKey!) + '/books' : null, revision);
  const book = books?.find(row => row.source_id === bookKey) ?? (books?.length === 1 ? books[0] : undefined);
  const hasBooks = Boolean(isNamedSystem && books?.length);
  const loadingBooks = isNamedSystem && !books && !booksError;
  const directoryView = hasBooks && !cardsView;
  const showCardTools = !folders && !directoryView && !loadingBooks && !booksError;
  function openBookView(source?: string, cards = false) {
    if (!systemKey) return;
    exitBatch();
    setTab('pages');
    const query = new URLSearchParams({system:systemKey});
    if (source) query.set('book',source);
    if (cards) query.set('view','cards');
    navigate('/wiki?' + query.toString());
  }
  const [bookSource, setBookSource] = useState<string | null>(null);
  useEffect(() => {
    setChosen(new Set()); setBatch(false); setSnapshot([]); setMoving(false);
    setSearch(''); setStatus('all'); setSystemForm(null); setTab('pages');
  }, [systemKey]);
  async function saveSystem(e: React.FormEvent) {
    e.preventDefault(); setSystemBusy(true); setSystemMessage('');
    try {
      const payload = { title: name.trim() };
      if (systemForm === 'rename' && system) await put(`/api/wiki/systems/${system.id}`, payload);
      else await post('/api/wiki/systems', payload);
      setSystemForm(null); refresh(); notify('知识体系已保存。');
    } catch (e) { setSystemMessage((e as Error).message); }
    finally { setSystemBusy(false); }
  }
  async function moveSelected() {
    setDeleting(true); setDeleteError('');
    try {
      await post('/api/wiki/batch-move', {
        ids: snapshot.map(p => p.id), versions: Object.fromEntries(snapshot.map(p => [p.id, p._version])),
        system_id: target === 'unassigned' ? null : target,
      });
      notify(`已调整 ${snapshot.length} 篇知识页的归属。`); exitBatch(); refresh();
    } catch (e) { setDeleteError((e as Error).message); }
    finally { setDeleting(false); }
  }
  function exitBatch() {
    setBatch(false); setChosen(new Set()); setSnapshot([]); setDeleteError(''); setMoving(false);
  }
  async function deleteSelected() {
    setDeleting(true); setDeleteError('');
    try {
      const result = await post<{ deleted: string[] }>('/api/wiki/batch-delete', {
        ids: snapshot.map(page => page.id), versions: Object.fromEntries(snapshot.map(page => [page.id, page._version])),
      });
      exitBatch(); refresh(); notify(`已删除 ${result.deleted.length} 篇知识页。`);
    } catch (e) { setDeleteError((e as Error).message); }
    finally { setDeleting(false); }
  }
  useEffect(() => { if (sourceId && canEdit) setNewOpen(true); }, [sourceId, canEdit]);
  if (id) return <WikiDetail key={id} id={id} />;
  const counts = new Map<string, number>();
  for (const page of pages || []) {
    const key = page.system_id || 'unassigned';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const nameSystem = (mode: 'new' | 'rename') => { setName(mode === 'rename' ? system?.title || '' : ''); setSystemMessage(''); setSystemForm(mode); };
  const openSystem = (key: string) => navigate(`/wiki?system=${encodeURIComponent(key)}`);
  const scoped = pages?.filter(p => systemKey === 'all' || (p.system_id || 'unassigned') === systemKey);
  const bookIds = bookKey && book && (books?.length || 0) > 1 ? new Set(book.entries.map(entry => entry.wiki_id)) : null;
  const cardPages = bookIds ? scoped?.filter(page => bookIds.has(page.id)) : scoped;
  const filtered = cardPages?.filter(p => (status === 'all' || status === p.status) && (p.title + p.summary + p.tags.join(' ')).toLowerCase().includes(search.toLowerCase()));
  const eligible = (filtered || []).filter(page => isAdmin || page.status === 'draft');
  const selected = eligible.filter(page => chosen.has(page.id));
  const all = eligible.length > 0 && selected.length === eligible.length;
  function toggle(page: WikiPage) {
    setChosen(old => { const next = new Set(old); if (next.has(page.id)) next.delete(page.id); else next.add(page.id); return next; });
  }
  if (systemKey && systemKey !== 'all' && systemKey !== 'unassigned' && !system) {
    if (systemLoading) return <BookDirectoryPlaceholder />;
    return <><button className="back-link" onClick={() => navigate('/wiki')}><ArrowLeft size={15} />返回体系目录</button><ErrorBox message={systemError || '该知识体系不存在。'} retry={refresh} /></>;
  }
  return <>{!folders && <button className="back-link" onClick={() => bookKey && (books?.length || 0) > 1 ? openBookView() : navigate('/wiki')}><ArrowLeft size={15} />{bookKey && (books?.length || 0) > 1 ? '返回本体系书目' : '返回体系目录'}</button>}<PageTitle eyebrow="FROM SOURCES TO UNDERSTANDING" title={folders ? '知识 Wiki' : book?.title || title} description={folders ? '按知识体系浏览，沿关联知识页继续学习。' : `共 ${cardPages?.length || 0} 篇知识页`} action={canEdit ? <div className="button-row"><Button variant="secondary" onClick={() => setManual(true)}><Plus size={16} />手动建立知识页</Button><Button onClick={() => setNewOpen(true)}><Sparkles size={16} />从资料整理</Button></div> : undefined} /><div className="research-tabs"><div className="tabs">{hasBooks ? <>
      <button className={tab === 'pages' && directoryView ? 'active' : ''} onClick={() => openBookView(bookKey || undefined)}>章节目录</button>
      <button className={tab === 'pages' && cardsView ? 'active' : ''} onClick={() => openBookView(bookKey || undefined,true)}>知识卡片</button>
    </> : <button className={tab === 'pages' ? 'active' : ''} onClick={() => setTab('pages')}>知识目录</button>}<button className={tab === 'audit' ? 'active' : ''} onClick={() => { exitBatch(); setTab('audit'); }}>质量检查{Boolean(audit?.issues.length) && <span>{audit?.issues.length}</span>}</button></div>{tab === 'pages' && showCardTools && <><div className="input-icon"><Search size={16} /><input aria-label="筛选 Wiki 知识页" value={search} onChange={e => { setChosen(new Set()); setSearch(e.target.value); }} placeholder="搜索主题、摘要或标签…" /></div><select className="wiki-status-filter" aria-label="Wiki 发布状态" value={status} onChange={e => { setChosen(new Set()); setStatus(e.target.value); }}><option value="all">全部状态</option><option value="draft">整理中的草稿</option><option value="published">已核对发布</option></select>{canEdit && <Button variant="secondary" onClick={() => batch ? exitBatch() : setBatch(true)}>{batch ? '取消批量选择' : '批量管理'}</Button>}</>}{tab === 'pages' && !folders && system && canEdit && <Button variant="ghost" onClick={() => nameSystem('rename')}>重命名体系</Button>}{tab === 'audit' && <Button variant="secondary" onClick={refresh}>重新检查</Button>}</div>
    {tab === 'pages' && showCardTools && batch && canEdit && <div className="wiki-selection-bar">
      <label><input type="checkbox" checked={all} disabled={!eligible.length} onChange={() => setChosen(all ? new Set() : new Set(eligible.map(p => p.id)))} />全选筛选结果</label>
      <span className="muted small">已选 {selected.length} 篇{!isAdmin && ' · 可管理草稿'}</span>
      <Button variant="secondary" disabled={!selected.length} onClick={() => { setMoving(true); setTarget(''); setSnapshot(selected); setDeleteError(''); }}>移入体系</Button>
      <Button variant="danger" disabled={!selected.length} onClick={() => { setMoving(false); setSnapshot(selected); setDeleteError(''); }}>删除所选知识页</Button>
    </div>}
    {bookSource && <NewWiki sourceId={bookSource} initialSystem={currentSystem} onClose={() => {setBookSource(null); refresh();}} />}
    {error && <ErrorBox message={error} retry={refresh} />}{tab === 'pages' ? folders ? <section>
      <div className="wiki-systems-heading"><h2>知识体系</h2><div className="button-row">
        <Button variant="ghost" onClick={() => openSystem('all')}>全部知识页</Button>
        {canEdit && <Button variant="secondary" onClick={() => nameSystem('new')}><Plus size={15} />新建体系</Button>}
      </div></div>
      {systemError && <ErrorBox message={systemError} retry={refresh} />}
      {systemLoading || loading ? <Loading /> : <div className="wiki-system-grid">
        {[...(systems || []), { id: 'unassigned', title: '待归类' }].map(row => <button key={row.id} className="panel wiki-system-card" aria-label={`打开体系「${row.title}」`} onClick={() => openSystem(row.id)}>
          <BookOpen size={22} /><span><strong>{row.title}</strong><small>{counts.get(row.id) || 0} 篇知识页</small></span><ArrowUpRight size={16} />
        </button>)}
      </div>}
    </section> : booksError ? <ErrorBox message={booksError} retry={refresh} /> : loadingBooks ? <BookDirectoryPlaceholder /> : directoryView ? (
      book ? <BookDirectory key={book.source_id} book={book} system={systemKey!} manage={canEdit ? () => setBookSource(book.source_id) : undefined} /> :
        <section aria-label="选择书籍" className="wiki-system-grid">{books?.map(row =>
          <button key={row.source_id} className="panel wiki-system-card" onClick={() => openBookView(row.source_id)}>
            <BookOpen size={22} /><span><strong>{row.title}</strong><small>{row.entries.filter(entry => entry.level === 1).length} 章</small></span><ArrowUpRight size={16} />
          </button>)}</section>
    ) : loading && !pages ? <Loading /> : filtered?.length ? <div className="wiki-grid">{filtered.map(page => <button key={page.id} className="panel wiki-card" role={batch ? 'checkbox' : undefined} aria-checked={batch ? chosen.has(page.id) : undefined} aria-label={batch ? `选择「${page.title}」` : undefined}
      disabled={batch && !isAdmin && page.status !== 'draft'} onClick={() => batch ? toggle(page) : navigate(book ? bookPageLink(book,page.id,systemKey!).slice(1) : '/wiki/' + page.id)}><div className="section-heading"><span className="wiki-kind">{batch ? <span aria-hidden="true" className={`wiki-choice ${chosen.has(page.id) ? 'checked' : ''}`}>{chosen.has(page.id) && '✓'}</span> : <BookOpen size={16} />}{KINDS[page.kind]}</span><Badge tone={page.status === 'published' ? 'mint' : 'orange'}>{page.status === 'published' ? '已发布' : '草稿'}</Badge></div><h2><MathText text={page.title} /></h2><p><MathText text={page.summary || '补充摘要，让主题更容易被找到。'} /></p><div className="wiki-tags">{page.tags.map(tag => <Badge key={tag} tone="gray">{tag}</Badge>)}</div><footer><span>{systemKey === 'all' ? systems?.find(row => row.id === page.system_id)?.title || '待归类' : page.category}</span><span>v{page._version} · {formatDate(page.updated_at)}<ArrowUpRight size={14} /></span></footer></button>)}</div> : <section className="panel"><Empty icon={<BookOpen size={28} />} title={scoped?.length ? '没有匹配的知识页' : '此目录还没有知识页'} text="围绕一个主题，将多份资料的证据串联起来。支持概念、方法实践和主题综述。" action={canEdit && <Button onClick={() => setNewOpen(true)}>整理第一篇知识页</Button>} /></section> : <section className="panel wiki-audit"><div className="section-heading"><h2>知识库质量检查</h2><small>{audit ? new Date(audit.checked_at).toLocaleString('zh-CN') : ''}</small></div><p className="muted">检查未整理资料、无来源页面、引用编号、孤立页面、同名页面、解析失败和未解决讨论。结果依据规则计算，需要你判断如何整理。</p>{auditError && <ErrorBox message={auditError} retry={refresh} />}{audit?.issues.map((issue, i) => <button className="wiki-issue" key={i} onClick={() => navigate(issue.path)}><span className={`wiki-issue-dot ${issue.severity}`} /><span><strong>{issue.title}</strong><small>{issue.detail}</small></span><ArrowUpRight size={16} /></button>)}{audit && !audit.issues.length && <Empty title="当前没有待处理提示" text="继续积累资料，并定期核对已发布知识页。" />}</section>}
    {systemForm && <Modal title={systemForm === 'new' ? '新建体系' : '重命名体系'} onClose={() => { if (!systemBusy) setSystemForm(null); }}>
      <form onSubmit={saveSystem}><Field label="体系名称"><input autoFocus required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></Field>
        {systemMessage && <ErrorBox message={systemMessage} />}
        <div className="form-footer"><Button type="button" variant="secondary" disabled={systemBusy} onClick={() => setSystemForm(null)}>取消</Button><Button type="submit" loading={systemBusy} disabled={!name.trim()}>保存体系</Button></div>
      </form>
    </Modal>}
    {snapshot.length > 0 && moving && <Modal title={`移动 ${snapshot.length} 篇知识页`} onClose={() => { if (!deleting) setSnapshot([]); }}>
      <Field label="目标体系"><select value={target} onChange={e => setTarget(e.target.value)}><option value="">请选择</option>
        {[...(systems || []), { id: 'unassigned', title: '待归类' }].filter(row => row.id !== systemKey).map(row => <option value={row.id} key={row.id}>{row.title}</option>)}
      </select></Field>
      <ul className="batch-delete-list">{snapshot.map(page => <li key={page.id}>{page.title}</li>)}</ul>
      {deleteError && <ErrorBox message={deleteError} />}
      <div className="form-footer"><Button variant="secondary" disabled={deleting} onClick={() => setSnapshot([])}>取消</Button>
        {deleteError && <Button variant="secondary" disabled={deleting} onClick={() => { setSnapshot([]); refresh(); }}>刷新并核对选择</Button>}
        <Button disabled={!target} loading={deleting} onClick={moveSelected}>确认移动</Button></div>
    </Modal>}
    {snapshot.length > 0 && !moving && <Modal title={`删除这 ${snapshot.length} 篇知识页？`} onClose={() => { if (!deleting) setSnapshot([]); }}>
      <p>将同时删除下列知识页的正文、历史版本、讨论与关联任务。此操作无法撤销。</p>
      <ul className="batch-delete-list">{snapshot.map(page => <li key={page.id}><strong>{page.title}</strong><small>v{page._version} · {page.status === 'draft' ? '草稿' : '已发布'}</small></li>)}</ul>
      {deleteError && <ErrorBox message={deleteError} />}
      <div className="form-footer"><Button variant="secondary" disabled={deleting} onClick={() => setSnapshot([])}>取消</Button>
        {deleteError && <Button variant="secondary" disabled={deleting} onClick={() => { setSnapshot([]); refresh(); }}>刷新并核对选择</Button>}
        <Button variant="danger" loading={deleting} onClick={deleteSelected}>确认删除 {snapshot.length} 篇</Button></div>
    </Modal>}
    {newOpen && <NewWiki sourceId={sourceId} initialSystem={currentSystem} onClose={() => setNewOpen(false)} />}{manual && <WikiEditor initial={{ ...blank(), ...(currentSystem !== undefined && { system_id: currentSystem }) }} onClose={() => setManual(false)} />}
  </>;
}
