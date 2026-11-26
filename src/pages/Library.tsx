import { Collaboration } from './Team';
import { Fragment, useRef, useState, useEffect, useMemo } from 'react';
import { Upload, Plus, Search, FileText, BookOpen, ArrowLeft, Trash2, Pencil, Download, RotateCw, Sparkles, MessageSquare, X, Check, StickyNote, ExternalLink } from 'lucide-react';
import { api, post, put, remove, useData, navigate, formatDate, fileSize } from '../api';
import { useApp, Button, PageTitle, Loading, ErrorBox, Empty, Badge, Modal, Field, Progress, IconButton, Confirm, Notice, RichText } from '../ui';
import { CATEGORIES, type Chunk, type Source, type SourceDetail, type Knowledge, type Note, type Settings } from '../types';
import { KnowledgeEditor } from './Knowledge';
import { revealSelection, type ReaderSelection } from '../readerSelection';
import { KnowledgeLinkEditor, SelectionToolbar } from './ReaderAnnotations';
import PdfParsing from './PdfParsing';
import { PdfFigures, ImageOnlyPages } from './PdfFigures';
import { MAX_FILE_BYTES, uploadSources } from '../uploads';

export function UploadModal({ onClose }: { onClose: () => void }) {
  const { refresh, notify } = useApp(), input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]), [category, setCategory] = useState(CATEGORIES[0]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('正在上传…');
  const [aiParsing, setAiParsing] = useState(false), [aiPages, setAiPages] = useState(10);
  const [aiAll, setAiAll] = useState(false);
  const hasPdf = files.some(file => /\.pdf$/i.test(file.name));
  const { data: modelSettings } = useData<Settings>(hasPdf ? '/api/settings' : null);
  function select(next: File[]) {
    setError(''); const candidates = [...files, ...next];
    if (candidates.length > 5) { setError('每次最多上传 5 份资料。'); return; }
    const oversized = candidates.find(f => f.size > MAX_FILE_BYTES);
    if (oversized) { setError(`《${oversized.name}》大小为 ${fileSize(oversized.size)}，单份资料不能超过 250 MB。`); return; }
    if (candidates.some(f => f.size === 0)) { setError('不能上传空文件。'); return; }
    if (candidates.some(f => !/\.(pdf|md|markdown|txt)$/i.test(f.name))) { setError('支持 PDF、Markdown 和 TXT 文件。'); return; }
    setFiles(candidates);
  }
  async function upload() {
    setBusy(true); setError('');
    try { await uploadSources(files, category, setUploadStatus, { parseMode: aiParsing && hasPdf ? 'ai' : 'standard', aiPages, aiAll }); refresh(); notify(aiParsing && hasPdf ? '上传完成，AI 版面解析已排队，请在资料阅读页核对并采用。' : '上传处理完成，请在资料库查看解析结果。'); navigate('/library'); onClose(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Modal title="添加学习资料" subtitle="把想读的书和已经积累的笔记，放进自己的知识空间。" onClose={() => { if (!busy) onClose(); }}><div className={`upload-drop ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) select(Array.from(e.dataTransfer.files)); }}><div className="upload-icon"><Upload size={29} strokeWidth={1.5} /></div><h3>拖放资料到这里</h3><p>或点击选择本机文件</p><Button variant="secondary" onClick={() => input.current?.click()} disabled={busy}>选择文件</Button><small>PDF / Markdown / TXT · 每份 ≤ 250 MB · 最多 5 份</small><input ref={input} type="file" aria-label="选择学习资料" accept=".pdf,.md,.markdown,.txt" multiple hidden onChange={e => { select(Array.from(e.target.files || [])); e.target.value = ''; }} /></div>{files.length > 0 && <div className="file-list">{files.map((f, i) => <div className="file-row" key={`${f.name}-${i}`}><FileText size={18} /><div><strong>{f.name}</strong><small>{fileSize(f.size)}</small></div><IconButton label={`移除 ${f.name}`} disabled={busy} onClick={() => setFiles(files.filter((_, n) => n !== i))}><X size={16} /></IconButton></div>)}</div>}<Field label="资料用途"><select value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></Field><p className="muted small">普通 PDF 解析自动恢复阅读顺序；扫描件或复杂多栏论文可按需使用 AI。文本文件请使用 UTF-8 编码。</p>{hasPdf && <div className="pdf-upload-option"><label className="check-label"><input type="checkbox" checked={aiParsing} onChange={e => setAiParsing(e.target.checked)} disabled={busy} />启用 AI 版面解析（可选）</label>{aiParsing && <><label className="check-label"><input type="checkbox" checked={aiAll} disabled={busy} onChange={e => setAiAll(e.target.checked)} />解析整份 PDF（后台连续处理）</label>{!aiAll && <Field label="AI 解析前多少页" hint="每份 PDF 从第 1 页开始，最多 50 页；可在阅读页继续选择其他范围。"><input type="number" min={1} max={50} required value={aiPages} onChange={e => setAiPages(Number(e.target.value))} /></Field>}<Notice>所选页面图片将发送到模型服务，可能产生费用；需支持图片输入。AI 结果先供核对，采用后才用于检索。</Notice>{!modelSettings?.configured && <ErrorBox message="请先由管理员在空间设置中连接支持图片输入的模型。" />}</>}</div>}{error && <ErrorBox message={error} />}<div className="form-footer"><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button loading={busy} disabled={!files.length || (aiParsing && hasPdf && (!modelSettings?.configured || (!aiAll && (!Number.isInteger(aiPages) || aiPages < 1 || aiPages > 50))))} onClick={upload}><Upload size={16} />{busy ? uploadStatus : `上传${files.length ? ` ${files.length} 份资料` : '资料'}`}</Button></div></Modal>;
}
export { default } from './LibraryManager';

export function NoteEditor({ sourceId, chunkId, note, selection = note?.selection, initialContent = '', onClose }: { selection?: ReaderSelection | null; sourceId: string; chunkId?: string | null; note?: Note; initialContent?: string; onClose: () => void }) {
  const { refresh, notify } = useApp(); const [title, setTitle] = useState(note?.title || selection?.quote.trim().slice(0, 36) || ''), [content, setContent] = useState(note?.content || initialContent), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title={note ? '编辑学习笔记' : '记下自己的理解'} onClose={onClose}><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { const b = { _version: (note as Note & { _version?: number } | undefined)?._version, title, content, source_id: sourceId, chunk_id: selection?.chunk_id || note?.chunk_id || chunkId || null, ...(selection && { selection }) }; if (note) await put(`/api/notes/${note.id}`, b); else await post('/api/notes', b); refresh(); notify('笔记已保存。'); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>{selection && <blockquote className="reader-quote">{selection.quote}</blockquote>}<Field label="笔记标题"><input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="用一句话概括你的思考" /></Field><Field label="笔记内容"><textarea rows={10} maxLength={30000} value={content} onChange={e => setContent(e.target.value)} placeholder="记录理解、疑问或一个具体例子…" /></Field>{error && <ErrorBox message={error} />}<div className="form-footer"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" loading={busy}>保存笔记</Button></div></form></Modal>;
}

// PDF indexing keeps a 150-character overlap for search. Rejoin the matching
// boundary before rendering Markdown so a table or code block can cross it.
function pdfReadingPages(chunks: Chunk[], historical = false) {
  const grouped = new Map<number, Chunk[]>();
  for (const chunk of chunks) {
    if ((chunk.active === 0) !== historical) continue;
    const page = grouped.get(chunk.page);
    if (page) page.push(chunk);
    else grouped.set(chunk.page, [chunk]);
  }
  return [...grouped.entries()].sort(([a], [b]) => a - b).map(([number, fragments]) => {
    fragments.sort((a, b) => a.position - b.position);
    let text = '';
    const anchors = fragments.map((chunk, index) => {
      let overlap = 0;
      if (index) {
        const previous = fragments[index - 1].content;
        for (let n = Math.min(150, previous.length, chunk.content.length); n >= 8; n--) {
          if (previous.endsWith(chunk.content.slice(0, n))) { overlap = n; break; }
        }
        if (!overlap) text += '\n\n';
      }
      const offset = text.length - overlap;
      text += chunk.content.slice(overlap);
      return { id: chunk.id, offset };
    });
    return { number, first: fragments[0], anchors, text };
  });
}

export function Reader({ sourceId, chunkId, from, linkId }: { sourceId: string; linkId?: string | null; chunkId?: string | null; from?: string | null }) {
  const { revision, refresh, notify, canEdit } = useApp();
  const paper = useRef<HTMLElement>(null);
  useEffect(() => () => { window.CSS?.highlights?.delete('reader-quote'); }, []);
  const [historyRange, setHistoryRange] = useState<ReaderSelection | null>(null);
  const [pendingReveal, setPendingReveal] = useState<ReaderSelection | null>(null);
  const [annotation, setAnnotation] = useState<{ type: 'note' | 'link'; selection: ReaderSelection } | null>(null);
  const [unlink, setUnlink] = useState<SourceDetail['knowledge_links'][number] | null>(null);
  const lookup = historyRange ? new URLSearchParams({ chunk: historyRange.chunk_id, end_chunk: historyRange.end_chunk_id })
    : chunkId ? new URLSearchParams({ chunk: chunkId }) : null;
  const { data: s, error, loading } = useData<SourceDetail>(`/api/sources/${sourceId}${lookup ? `?${lookup}` : ''}`, revision, 3000);
  const { data: knowledge } = useData<Knowledge[]>('/api/knowledge', revision);
  const [tab, setTab] = useState('知识点'), [selected, setSelected] = useState(chunkId || ''), [note, setNote] = useState<Note | 'new' | null>(null), [editingKnowledge, setEditingKnowledge] = useState<Knowledge | 'new' | null>(null), [confirm, setConfirm] = useState(false), [edit, setEdit] = useState(false), [generating, setGenerating] = useState(false), [progressValue, setProgressValue] = useState<number | null>(null);
  const [deletingNote, setDeletingNote] = useState<Note | null>(null);
  useEffect(() => { setSelected(chunkId || ''); }, [chunkId]);
  useEffect(() => { if (chunkId && !historyRange && s?.chunks.length) { const timer = setTimeout(() => document.getElementById(`chunk-${chunkId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80); return () => clearTimeout(timer); } }, [chunkId, Boolean(s?.chunks.length), historyRange]);
  const [organizeOpen, setOrganizeOpen] = useState(false), [focus, setFocus] = useState(''), [organizeError, setOrganizeError] = useState('');
  async function generate() {
    setGenerating(true); setOrganizeError('');
    try {
      const result = await post(`/api/sources/${sourceId}/generate`, { focus });
      const count = result.items.length;
      notify(`参考 ${result.used_chunks}/${result.total_chunks} 个片段，${count ? `新增 ${count} 个知识点草稿` : '同名知识点已整理'}。`);
      setOrganizeOpen(false); setTab('知识点'); refresh();
    } catch (e) { setOrganizeError((e as Error).message); }
    finally { setGenerating(false); }
  }
  async function updateProgress(value: number) { try { await api(`/api/sources/${sourceId}`, { method: 'PATCH', body: JSON.stringify({ read_progress: value }) }); refresh(); notify('阅读进度已更新。'); setProgressValue(null); } catch (e) { notify((e as Error).message, 'error'); } }
  const pages = useMemo(() => s?.type === 'pdf' ? pdfReadingPages(s.chunks) : [], [s?.chunks, s?.type]);
  const historicalPages = useMemo(() => historyRange && s?.type === 'pdf' ? pdfReadingPages(s.chunks, true) : [], [historyRange, s?.chunks, s?.type]);
  function showSelection(selection: ReaderSelection) {
    setSelected(selection.chunk_id);
    if (paper.current && revealSelection(paper.current, selection)) return;
    setHistoryRange(selection);
    setPendingReveal(selection);
  }
  const openedLink = useRef<string | null>(null);
  useEffect(() => {
    if (!linkId) { openedLink.current = null; return; }
    if (!s || openedLink.current === linkId) return;
    openedLink.current = linkId;
    const link = s.knowledge_links?.find(l => l.id === linkId);
    if (link) showSelection(link.selection);
    else notify('这条原文关联已解除。');
  }, [linkId, s]);
  useEffect(() => {
    if (!pendingReveal || !s || !paper.current) return;
    // A change of query first renders the previous response. Wait for the selected fragments.
    if (!s.chunks.some(c => c.id === pendingReveal.chunk_id) || !s.chunks.some(c => c.id === pendingReveal.end_chunk_id)) return;
    if (!revealSelection(paper.current, pendingReveal))
      notify('当前正文无法精确定位，可在侧栏查看保存的原文摘录。');
    setPendingReveal(null);
  }, [pendingReveal, s]);
  if (loading && !s) return <Loading />;
  if (error || !s) return <ErrorBox message={error} retry={refresh} />;
  const current = s.chunks.find(c => c.id === selected) || s.chunks[0];
  const displayPages = historicalPages.length ? [...new Map([...pages, ...historicalPages].map(p => [p.number, p])).values()].sort((a,b) => a.number - b.number) : pages;
  const finalTextPage = displayPages.at(-1)?.number || 0;
  const imageOnly = s.type === 'pdf' && pages.length === 0;
  const directory = s.type === 'pdf' ? pages.map(p => p.first) : s.chunks;
  const links = s.knowledge_links || [];
  const related = knowledge?.filter(k => k.source_id === sourceId || links.some(link => link.knowledge_id === k.id)) || [];
  const go = (id: string) => { setHistoryRange(null); setPendingReveal(null); setSelected(id); navigate(`/library/${sourceId}?chunk=${id}${from ? `&from=${from}` : ''}`); };
  return <><button className="back-link" onClick={() => navigate(from ? `/chat/${from}` : '/library')}><ArrowLeft size={15} />{from ? '返回学习对话' : '返回资料库'}</button><PageTitle title={s.title} description={`${s.category} · ${s.type === 'pdf' ? 'PDF' : 'Markdown / TXT'} · ${fileSize(s.size)} · ${formatDate(s.created_at)}添加`} action={<div className="button-row"><IconButton label="编辑资料信息" onClick={() => setEdit(true)}><Pencil size={17} /></IconButton><a className="icon-button" href={`/api/sources/${s.id}/file`} download={s.filename} aria-label="下载原始资料" title="下载原始资料"><Download size={17} /></a><IconButton label="删除资料" onClick={() => setConfirm(true)}><Trash2 size={17} /></IconButton></div>} />
  {s.type === 'pdf' && <PdfParsing source={s} />}
  {current?.active === 0 && <Notice>当前引用来自历史解析版本。原文片段已保留，不会因采用新的 AI 解析而改变。</Notice>}
  {s.status === 'processing' ? <div className="panel processing-card"><div className="processing-icon"><RotateCw size={30} className="spin" /></div><h2>正在整理这份资料</h2><p>解析正文、保留来源位置，准备好后即可开始阅读。</p><Progress value={s.progress} /><span>{s.progress}%</span></div> : s.status === 'failed' ? <div className="panel"><Empty title="这份资料暂时没有解析成功" text={s.error} action={<Button onClick={async () => { try { await post(`/api/sources/${sourceId}/retry`); refresh(); } catch (e) { notify((e as Error).message, 'error'); } }}><RotateCw size={16} />重新解析</Button>} /></div> : <>
  {imageOnly && <Notice>这份 PDF 可按原页阅读。要整理 Wiki 和知识点，请先使用 AI 版面解析识别并采用正文。</Notice>}
  <div className="reader-toolbar"><div className="reader-progress"><span>阅读进度</span><input type="range" aria-label="阅读进度" min="0" max="100" value={progressValue ?? s.read_progress} onChange={e => setProgressValue(Number(e.target.value))} /><strong>{progressValue ?? s.read_progress}%</strong>{progressValue !== null && <Button variant="secondary" onClick={() => updateProgress(progressValue)}>保存</Button>}</div><div className="button-row">{s.type === 'pdf' && <a className="text-button" href={`/api/sources/${sourceId}/file#page=${current?.page || 1}`} target="_blank" rel="noreferrer">打开完整 PDF</a>}<Button write variant="secondary" disabled={imageOnly} onClick={() => navigate(`/wiki?source=${sourceId}`)}><BookOpen size={15} />整理到 Wiki</Button><Button write variant="secondary" disabled={imageOnly} onClick={() => { setOrganizeError(''); setOrganizeOpen(true); }}><Sparkles size={15} />整理知识点</Button><Button onClick={async () => { try { const c = await post('/api/conversations', { source_id: s.id }); refresh(); navigate(`/chat/${c.id}`); } catch (e) { notify((e as Error).message, 'error'); } }}><MessageSquare size={15} />针对资料提问</Button></div></div>
  <div className="reader-layout"><aside className="reader-toc panel"><h3>内容目录<span>{s.pages} {s.type === 'pdf' ? '页' : '节'}</span></h3>{s.type === 'pdf' && <p className="muted small">已整理 {directory.length} 页正文</p>}<div className="toc-scroll">{directory.map((c, i) => <button key={c.id} className={(s.type === 'pdf' ? current?.page === c.page : current?.id === c.id) ? 'active' : ''} onClick={() => go(c.id)}><span>{String(i + 1).padStart(2, '0')}</span>{s.type === 'pdf' ? `第 ${c.page} 页` : c.heading}</button>)}</div></aside><article ref={paper} className="reading-paper"><div className="paper-caption">{s.ai_pages ? '资料正文 · 含 AI 校对页' : '原文阅读'}<span>{s.filename}</span></div>{s.type === 'pdf' ? <>
    {!historyRange && current?.active === 0 && <section data-reader-chunk={current.id} id={`chunk-${current.id}`} className="text-chunk selected"><h2>历史引用片段 · 第 {current.page} 页</h2><RichText text={current.content} /></section>}
    {displayPages.map((page, index) => {
      const priorPage = displayPages[index - 1]?.number || 0;
      const active = current?.active !== 0 && current?.page === page.number;
      const noteChunk = active ? current.id : page.first.id;
      return <Fragment key={page.number}>
        {priorPage + 1 < page.number && <ImageOnlyPages sourceId={sourceId} first={priorPage + 1} last={page.number - 1} />}
        <section className={`text-chunk ${active ? 'selected' : ''}`}
        onClick={e => { if (window.getSelection()?.isCollapsed === false) return; setSelected((e.target as Element).closest<HTMLElement>('[data-chunk]')?.dataset.chunk || page.first.id); }}>
        <div className="chunk-caption"><h2>{page.first.active === 0 ? '历史引用片段 · ' : ''}第 {page.number} 页</h2><button hidden={!canEdit} className="text-button" onClick={e => { e.stopPropagation(); setSelected(noteChunk); setNote('new'); }}>记笔记<Plus size={13} /></button></div>
        <RichText text={page.text} anchors={page.anchors} />
        <PdfFigures sourceId={sourceId} page={page.number} />
      </section></Fragment>;
    })}
    {finalTextPage < s.pages && <ImageOnlyPages sourceId={sourceId} first={finalTextPage + 1} last={s.pages} />}
  </> : s.chunks.map(c => <section key={c.id} data-reader-chunk={c.id} id={`chunk-${c.id}`} className={`text-chunk ${current?.id === c.id ? 'selected' : ''}`} onClick={() => setSelected(c.id)}><div className="chunk-caption"><span>{`片段 ${c.page}`}</span><button hidden={!canEdit} className="text-button" onClick={e => { e.stopPropagation(); setSelected(c.id); setNote('new'); }}>记笔记<Plus size={13} /></button></div><h2>{c.heading}</h2><RichText text={c.content} /></section>)}</article><aside className="reader-side panel"><div className="tabs">{['知识点', '学习笔记'].map(t => <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>{t}<span>{t === '知识点' ? related.length : s.notes.length}</span></button>)}</div>{tab === '知识点' ? <><Button write variant="secondary" className="full" onClick={() => setEditingKnowledge('new')}><Plus size={15} />添加知识点</Button>{related.map(k => <div key={k.id}><button className="reader-knowledge" onClick={() => canEdit ? setEditingKnowledge(k) : navigate(`/knowledge?focus=${k.id}`)}><div><h4>{k.title}</h4><Badge tone={k.draft ? 'orange' : 'mint'}>{k.draft ? '待确认草稿' : k.mastery}</Badge></div><p>{k.summary.slice(0, 130)}</p></button>{links.filter(link => link.knowledge_id === k.id).map(link => <div className="reader-note" key={link.id}>

      <blockquote className="reader-quote">{link.selection.quote}</blockquote>
      <div className="note-actions"><button className="text-button" onClick={() => showSelection(link.selection)}>查看原文选区</button>{canEdit && <button className="text-button" onClick={() => setUnlink(link)}>解除关联</button>}</div>
    </div>)}</div>)}{!related.length && !links.length && <div className="subtle-empty">把重要概念整理成知识点，之后可以练习与复习。</div>}</> : <><Button write variant="secondary" className="full" onClick={() => setNote('new')}><Plus size={15} />添加笔记</Button>{s.notes.map(n => <div className="reader-note" key={n.id}><div className="section-heading"><h4>{n.title}</h4><IconButton label={`编辑笔记 ${n.title}`} onClick={() => setNote(n)}><Pencil size={14} /></IconButton></div><RichText text={n.content} />{n.selection && <blockquote className="reader-quote">{n.selection.quote}</blockquote>}<div className="note-actions">{n.selection ? <button className="text-button" onClick={() => showSelection(n.selection!)}>查看原文选区</button> : n.chunk_id && <button className="text-button" onClick={() => go(n.chunk_id!)}>查看来源</button>}<button hidden={!canEdit} className="text-button danger-text" onClick={() => { setDeletingNote(n); }}>删除</button></div></div>)}{!s.notes.length && <div className="subtle-empty">自己的解释、例子和问题，值得被记录。</div>}</>}</aside></div></>}
  {canEdit && !annotation && !note && s.status === 'ready' && <SelectionToolbar paper={paper} onAction={(type, selection) => { setAnnotation({ type, selection }); setTab(type === 'note' ? '学习笔记' : '知识点'); }} />}
  {annotation?.type === 'note' && <NoteEditor sourceId={sourceId} selection={annotation.selection} onClose={() => setAnnotation(null)} />}
  {annotation?.type === 'link' && <KnowledgeLinkEditor sourceId={sourceId} selection={annotation.selection} knowledge={knowledge || []} onClose={() => setAnnotation(null)} />}
  {unlink && <Confirm title="解除这条原文关联？" text={unlink.selection.quote} confirmLabel="解除关联" onClose={() => setUnlink(null)} onConfirm={async () => { await remove(`/api/sources/${sourceId}/knowledge-links/${unlink.id}`); refresh(); notify('已解除关联。'); }} />}
  {note && <NoteEditor sourceId={sourceId} chunkId={current?.id} note={note === 'new' ? undefined : note} onClose={() => setNote(null)} />}
  {organizeOpen && <Modal title="整理知识点" onClose={() => { if (!generating) setOrganizeOpen(false); }}>
    <form onSubmit={e => { e.preventDefault(); void generate(); }}>
      <Field label="你想弄懂什么？" hint="留空会从整份资料的不同位置选取核心概念。">
        <textarea autoFocus rows={3} maxLength={500} value={focus} onChange={e => setFocus(e.target.value)} placeholder="例如：为什么图像平滑会损失边缘细节？" />
      </Field>
      {organizeError && <ErrorBox message={organizeError} />}
      <div className="form-footer"><Button type="button" variant="secondary" disabled={generating} onClick={() => setOrganizeOpen(false)}>取消</Button><Button type="submit" loading={generating}>生成知识点草稿</Button></div>
    </form>
  </Modal>}
  {editingKnowledge && <KnowledgeEditor item={editingKnowledge === 'new' ? undefined : editingKnowledge} initialSource={sourceId} initialChunk={current?.id} onClose={() => setEditingKnowledge(null)} />}
  {edit && <SourceEditor source={s} onClose={() => setEdit(false)} />}
  <Collaboration kind="source" targetId={sourceId} />
  {confirm && <Confirm title="删除这份资料？" text="原始文件、来源片段和资料笔记将被删除。知识点与练习会保留，关联的原文来源将解除。" onClose={() => setConfirm(false)} onConfirm={async () => { await remove(`/api/sources/${sourceId}`); refresh(); notify('资料已删除。'); navigate('/library'); }} />}
  {deletingNote && <Confirm title="删除这条笔记？" text="删除后无法恢复，请确认已经保存需要保留的内容。" onClose={() => setDeletingNote(null)} onConfirm={async () => { await remove(`/api/notes/${deletingNote.id}`); refresh(); notify('笔记已删除。'); }} />}
  </>;
}
function SourceEditor({ source, onClose }: { source: Source; onClose: () => void }) {
  const { refresh, notify } = useApp(); const [title, setTitle] = useState(source.title), [category, setCategory] = useState(source.category), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title="编辑资料信息" onClose={onClose}><form onSubmit={async e => { e.preventDefault(); setBusy(true); try { await api(`/api/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify({ title, category, _version: (source as Source & { _version?: number })._version }) }); refresh(); notify('资料信息已更新。'); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Field label="资料名称"><input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></Field><Field label="资料用途"><select value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></Field>{error && <ErrorBox message={error} />}<div className="form-footer"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button loading={busy}>保存修改</Button></div></form></Modal>;
}
