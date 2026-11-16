import { useEffect, useRef, useState } from 'react';
import { BookOpen, ListChecks, Plus, Search, Trash2, Upload } from 'lucide-react';
import { api, fileSize, navigate, post, useData } from '../api';
import { Badge, Button, Empty, ErrorBox, Loading, Modal, Notice, PageTitle, useApp } from '../ui';
import { CATEGORIES, type Source } from '../types';
import { BookCard } from './Home';

type DeleteItem = { id: string; title: string; _version: number; size: number; notes: number; canDelete: boolean; reason: string };
type DeletePreview = { items: DeleteItem[]; deletableCount: number; blockedCount: number };
type DeleteResult = { deleted: DeleteItem[]; blocked: DeleteItem[]; deletedCount: number; blockedCount: number };

export default function LibraryManager() {
  const { revision, refresh, notify, upload, canEdit } = useApp();
  const { data, error, loading } = useData<Source[]>('/api/sources', revision, 3000);
  const [category, setCategory] = useState('全部资料'), [search, setSearch] = useState('');
  const [sampleBusy, setSampleBusy] = useState(false), [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [deleting, setDeleting] = useState<string[] | null>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const filtered = data?.filter(source => (category === '全部资料' || source.category === category) && source.title.toLowerCase().includes(search.toLowerCase())) || [];
  const checked = filtered.filter(source => selected.has(source.id)).length;
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = checked > 0 && checked < filtered.length; }, [checked, filtered.length, managing]);
  useEffect(() => {
    if (!data) return;
    const available = new Set(data.map(source => source.id));
    setSelected(previous => [...previous].every(id => available.has(id)) ? previous : new Set([...previous].filter(id => available.has(id))));
  }, [data]);
  function toggleAll() {
    const next = new Set(selected);
    if (filtered.length && checked === filtered.length) filtered.forEach(source => next.delete(source.id));
    else {
      filtered.forEach(source => { if (next.size < 100) next.add(source.id); });
      if (filtered.some(source => !next.has(source.id))) notify('每批最多选择 100 份资料，可以分批处理。');
    }
    setSelected(next);
  }
  async function sample() {
    setSampleBusy(true);
    try { await post('/api/sources/sample'); refresh(); notify('示例已添加，解析完成后即可体验阅读和引用。'); }
    catch (error) { notify((error as Error).message, 'error'); } finally { setSampleBusy(false); }
  }
  return <>
    <PageTitle eyebrow="YOUR PERSONAL LIBRARY" title="我的资料库" description="书籍、论文与实践笔记，每一份输入都有自己的位置。" action={<div className="button-row library-actions">
      <Button write variant="secondary" onClick={() => { setManaging(!managing); setSelected(new Set()); }}><ListChecks size={17} />{managing ? '退出批量管理' : '批量管理'}</Button>
      <Button write onClick={upload}><Plus size={17} />上传资料</Button>
    </div>} />
    <div className="library-toolbar"><div className="tabs scroll-tabs">{['全部资料', ...CATEGORIES].map(value => <button key={value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{value}{value === '全部资料' && <span>{data?.length || 0}</span>}</button>)}</div><div className="input-icon library-search"><Search size={16} /><input aria-label="按资料名称筛选" placeholder="搜索资料名称…" value={search} onChange={e => setSearch(e.target.value)} /></div></div>
    {managing && canEdit && <div className="library-batch-bar panel" aria-label="资料批量管理">
      <label className="check-label"><input ref={allRef} type="checkbox" checked={filtered.length > 0 && checked === filtered.length} disabled={!filtered.length} onChange={toggleAll} />选择当前筛选结果</label>
      <span>已选择 <strong>{selected.size}</strong> 份 · 当前筛选 {filtered.length} 份</span>
      <div className="button-row"><Button variant="ghost" disabled={!selected.size} onClick={() => setSelected(new Set())}>清空选择</Button><Button variant="danger" disabled={!selected.size} onClick={() => setDeleting([...selected])}><Trash2 size={15} />批量删除（{selected.size}）</Button></div>
      <small className="muted">可跨分类选择，每批最多 100 份。全选只影响当前筛选结果，删除前会列出影响范围。</small>
    </div>}
    {error && <ErrorBox message={error} retry={refresh} />}
    {loading && !data ? <Loading /> : filtered.length ? <>
      <div className="list-caption">共 {filtered.length} 份资料<span>按添加时间排列</span></div>
      <div className="book-grid library-books">{filtered.map(source => managing && canEdit ? <div className={`library-selectable ${selected.has(source.id) ? 'is-selected' : ''}`} key={source.id}>
        <label className="library-select-control"><input type="checkbox" aria-label={`选择资料 ${source.title}`} checked={selected.has(source.id)} disabled={!selected.has(source.id) && selected.size >= 100} onChange={e => { const next = new Set(selected); if (e.target.checked) next.add(source.id); else next.delete(source.id); setSelected(next); }} /><span>选择</span></label>
        <BookCard source={source} />
      </div> : <BookCard source={source} key={source.id} />)}</div>
    </> : data?.length ? <Empty title="没有找到相关资料" text="试试其他名称或资料分类。" action={<Button variant="secondary" onClick={() => { setSearch(''); setCategory('全部资料'); }}>清除筛选</Button>} /> : <div className="panel"><Empty title="从你的第一份资料开始" text="把正在学的书、课程笔记或项目文档放进来，让知识慢慢连接。" action={<div className="button-row"><Button write onClick={upload}><Upload size={16} />上传我的资料</Button><Button write variant="secondary" loading={sampleBusy} onClick={sample}>体验原创示例</Button></div>} /></div>}
    <div className="library-footnote"><BookOpen size={16} /><span>原始资料与学习记录保存在服务端，换一个浏览器也能继续。</span></div>
    {deleting && <BatchDeleteDialog ids={deleting} onClose={() => setDeleting(null)} onComplete={result => {
      setSelected(new Set(result.blocked.map(item => item.id))); refresh();
    }} />}
  </>;
}

function DeleteList({ items, result = false }: { items: DeleteItem[]; result?: boolean }) {
  return <ul className="batch-delete-list">{items.map(item => <li key={item.id}>
    <div><strong>{item.title}</strong><Badge tone={item.canDelete ? 'orange' : 'gray'}>{item.canDelete ? '将删除' : result ? '未删除' : '暂不删除'}</Badge></div>
    <p className="muted small">{item.canDelete ? `${fileSize(item.size)} · ${item.notes} 条资料笔记` : item.reason}</p>
    {!item.canDelete && <Button variant="ghost" onClick={() => navigate(`/library/${item.id}`)}>查看资料与关联</Button>}
  </li>)}</ul>;
}

function BatchDeleteDialog({ ids, onClose, onComplete }: { ids: string[]; onClose: () => void; onComplete: (result: DeleteResult) => void }) {
  const [preview, setPreview] = useState<DeletePreview | null>(null), [result, setResult] = useState<DeleteResult | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  const selection = ids.join(',');
  useEffect(() => {
    const controller = new AbortController(); setPreview(null); setError('');
    void api<DeletePreview>('/api/sources/batch-delete/preview', { method: 'POST', body: JSON.stringify({ ids }), signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPreview(value); })
      .catch(error => { if (!controller.signal.aborted) setError((error as Error).message); });
    return () => controller.abort();
  }, [selection, attempt]);
  return <Modal title="批量删除资料" subtitle="先确认所选资料和关联影响，再执行删除。" wide onClose={() => { if (!busy) onClose(); }}>
    {result ? <><Notice>已删除 {result.deletedCount} 份资料，{result.blockedCount} 份未删除。</Notice>
      {!!result.blockedCount && <DeleteList items={result.blocked} result />}
      <div className="form-footer"><Button onClick={onClose}>完成</Button></div>
    </> : <>
      {!preview && !error && <Loading />}
      {error && <ErrorBox message={error} retry={() => setAttempt(value => value + 1)} />}
      {preview && <><Notice>选中 {ids.length} 份，其中 {preview.deletableCount} 份可删除，{preview.blockedCount} 份暂不删除。删除会移除原始文件、正文、资料笔记、解析任务及关联讨论任务；知识点、计划与对话保留，并解除资料关联。此操作不能撤销。</Notice>
        <DeleteList items={preview.items} />
      </>}
      <div className="form-footer"><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button variant="danger" loading={busy} disabled={!preview?.deletableCount} onClick={async () => {
        if (!preview) return; setBusy(true); setError('');
        try {
          const eligible = preview.items.filter(item => item.canDelete);
          const executed = await post<DeleteResult>('/api/sources/batch-delete', { ids: eligible.map(item => item.id), versions: Object.fromEntries(eligible.map(item => [item.id, item._version])) });
          const kept = preview.items.filter(item => !item.canDelete);
          const value = { ...executed, blocked: [...kept, ...executed.blocked], blockedCount: kept.length + executed.blockedCount };
          setResult(value); onComplete(value);
        } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      }}><Trash2 size={15} />删除可删除的 {preview?.deletableCount || 0} 份资料</Button></div>
    </>}
  </Modal>;
}
