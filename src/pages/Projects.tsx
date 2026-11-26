import { lazy, Suspense, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight, FileText, GitFork, Link2, Pause, Plus, RefreshCw, Save, Search, Sparkles, Trash2 } from 'lucide-react';
import { navigate, post, remove, useData, formatDate } from '../api';
import { Badge, Button, Confirm, Empty, ErrorBox, Field, IconButton, Loading, Modal, PageTitle, RichText, useApp } from '../ui';
import type { Knowledge, WikiPage } from '../types';
import type { SourceRange } from './ProjectReader';

type Counts = { total: number; indexed: number; skipped: number; unavailable?: number };
type Snapshot = { id: string; revision: string; created_at: string };
type Project = { id: string; url: string; repo: string; status: keyof typeof statuses; counts: Counts; error: string; ref: string; scope: string; objective: string; current_snapshot: string; staging: string };
type Step = { id: string; title: string; task: string; files: { path: string; blob: string }[] };
type Record = { step: string; stage: string; note: string };
type Detail = Project & { snapshot: Snapshot; snapshots: Snapshot[]; route: Step[]; progress: Record[]; guide: string; guide_refs?: Reference[]; changes?: { added: number; modified: number; removed: number } };
type Reference = { path: string; first: number; last: number; url: string; text: string };
type ProjectLink = { id: string; path: string; first: number; last: number; snapshot_id: string; revision: string; relation: string; note: string; wiki_id?: string; knowledge_id?: string; title?: string; project_id?: string; repo?: string };
const statuses = { queued: '排队中', importing: '正在导入', paused: '已暂停', failed: '导入失败', ready: '可学习' };
const stages = { todo: '未开始', read: '已阅读', understood: '已理解', practiced: '已实践' };
const deleteImpact = '导入任务将停止，项目的版本、导读、学习记录和源码关联将被删除，且无法恢复。GitHub 仓库、Wiki 页面、知识点和已有学习计划不会被删除。';
const ProjectReader = lazy(() => import('./ProjectReader'));
const projectPath = (id: string, snapshot: string, path?: string, line = 1) =>
  `/projects/${id}?${new URLSearchParams({ snapshot, ...(path ? { view: 'files', path, line: String(line) } : {}) })}`;

export function ProjectBacklinks({ type, id }: { type: 'wiki' | 'knowledge'; id: string }) {
  const { data, error } = useData<ProjectLink[]>(`/api/projects/related?type=${type}&id=${encodeURIComponent(id)}`);
  if (error || !data?.length) return null;
  return <section className="project-section"><h3>关联源码</h3><ul className="project-links">{data.map(link => <li key={link.id}>
    <a href={`#${projectPath(link.project_id!, link.snapshot_id, link.path, link.first)}`}>{link.repo} · {link.path}:{link.first} <ArrowUpRight size={13} /></a>
    <small>{link.relation} · {link.revision.slice(0, 8)}{link.note && ` · ${link.note}`}</small>
  </li>)}</ul></section>;
}

export default function Projects({ id, query }: { id: string; query: URLSearchParams }) {
  return id ? <ProjectDetail id={id} query={query} /> : <ProjectIndex />;
}

function ProjectIndex() {
  const { canEdit, notify } = useApp();
  const [revision, setRevision] = useState(0), [deleting, setDeleting] = useState<Project>();
  const { data, error, loading } = useData<Project[]>('/api/projects', revision, 3000);
  const [url, setUrl] = useState(''), [objective, setObjective] = useState(''), [goal, setGoal] = useState('architecture');
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  return <div className="project-workspace"><PageTitle eyebrow="GITHUB WORKSPACE" title="互联网学习" />
    {canEdit && <form className="project-import project-section" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setFailure('');
      try { const project = await post<Project>('/api/projects', { url, objective, goal }); navigate(`/projects/${project.id}`); }
      catch (err) { setFailure((err as Error).message); } finally { setBusy(false); }
    }}>
      <Field label="GitHub 链接"><input type="url" required placeholder="https://github.com/owner/repo" value={url} onChange={e => setUrl(e.target.value)} /></Field>
      <Field label="学习方向"><select value={goal} onChange={e => setGoal(e.target.value)}><option value="quick">快速上手</option><option value="architecture">理解架构</option><option value="implementation">深入实现</option></select></Field>
      <Field label="关注的问题（可选）"><input maxLength={400} value={objective} onChange={e => setObjective(e.target.value)} /></Field>
      <Button loading={busy}><Plus size={15} />导入项目</Button>
    </form>}
    {(failure || error) && <ErrorBox message={failure || error} />}
    <section className="project-section"><h2>项目空间</h2>
      {loading && !data ? <Loading /> : data?.length ? <ul className="project-list">{data.map(project => <li key={project.id}>
        <a href={`#/projects/${project.id}`}><GitFork size={18} /><strong>{project.repo}</strong><span>{project.scope || '整个仓库'}</span>
          <small>{project.counts.indexed} / {project.counts.total} 文件</small><Badge>{statuses[project.status]}</Badge><ChevronRight size={16} /></a>
        <IconButton label={`删除项目 ${project.repo}${project.scope ? ' / ' + project.scope : ''}`} onClick={() => setDeleting(project)}><Trash2 size={16} /></IconButton>
      </li>)}</ul> : !error && <Empty title="还没有项目" text="可导入公开 GitHub 仓库、目录或文件。" icon={<GitFork size={25} />} />}
    </section>
    {deleting && <Confirm title={`删除项目 ${deleting.repo}${deleting.scope ? ' / ' + deleting.scope : ''}？`} text={deleteImpact} onClose={() => setDeleting(undefined)} onConfirm={async () => {
      await remove(`/api/projects/${deleting.id}`); setRevision(n => n + 1); notify('项目已删除');
    }} />}
  </div>;
}

function ProjectDetail({ id, query }: { id: string; query: URLSearchParams }) {
  const { canEdit, notify } = useApp();
  const endpoint = `/api/projects/${id}`, selected = query.get('snapshot') || '';
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [sourceLink, setSourceLink] = useState<SourceRange>();
  const [guideResult, setGuideResult] = useState<{ snapshot: string; answer: Answer }>();
  const { data, error } = useData<Detail>(`${endpoint}?snapshot=${encodeURIComponent(selected)}`, revision, 2500);
  const view = query.get('view') || 'route';
  const sid = data?.snapshot?.id || '';
  const guide = guideResult?.snapshot === sid ? guideResult.answer : data?.guide ? { answer: data.guide, references: data.guide_refs || [], mode: 'model' } : undefined;
  const changeView = (view: string) => navigate(`/projects/${id}?${new URLSearchParams({ ...(selected ? { snapshot: selected } : {}), view })}`);
  const openFile = (path: string, line = 1) => navigate(projectPath(id, sid, path, line));
  const sync = async (action: string) => {
    setBusy(true); setFailure('');
    try { await post(`${endpoint}/sync`, { action }); setRevision(n => n + 1); }
    catch (e) { setFailure((e as Error).message); } finally { setBusy(false); }
  };
  if (!data) return error ? <ErrorBox message={error} retry={() => setRevision(n => n + 1)} /> : <Loading />;
  const importing = ['queued', 'importing'].includes(data.status);
  return <div className="project-workspace">
    <a className="back-link" href="#/projects"><ArrowLeft size={15} />互联网学习</a>
    {view !== 'files' ? <PageTitle eyebrow="PROJECT WORKSPACE" title={data.repo} description={data.objective} action={<div className="project-actions">
      <a className="button secondary" href={data.url} target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={14} /></a>
      {canEdit && <Button variant="secondary" loading={busy} onClick={() => void sync(importing ? 'pause' : 'sync')}>
        {importing ? <Pause size={15} /> : <RefreshCw size={15} />}{importing ? '暂停导入' : data.status === 'ready' ? '检查更新' : '继续导入'}
      </Button>}
      <IconButton label="删除项目" disabled={busy} onClick={() => setDeleting(true)}><Trash2 size={17} /></IconButton>
    </div>} /> : <h2 className="reader-project-title">{data.repo}</h2>}
    <div className="project-meta">
      <Badge tone={data.status === 'ready' ? 'mint' : 'purple'}>{statuses[data.status]}</Badge>
      <span>{data.scope || '整个仓库'}{data.ref && ` · ${data.ref === 'HEAD' ? '默认分支' : data.ref}`}</span>
      {importing && !data.counts.total ? <span>等待 GitHub 文件清单</span> : <span>已索引 {data.counts.indexed} / {data.counts.total} · 跳过 {data.counts.skipped}{data.counts.unavailable ? ` · 待补齐 ${data.counts.unavailable}` : ''}</span>}
      {data.changes && <span>较上一版本：新增 {data.changes.added} · 修改 {data.changes.modified} · 移除 {data.changes.removed}</span>}
      {data.snapshots.length > 0 && <Field label="版本"><select value={selected || ''} onChange={e => navigate(`/projects/${id}?${new URLSearchParams({ view, snapshot: e.target.value })}`)}>
        <option value="">当前版本 · {data.snapshots.find(s => s.id === data.current_snapshot)?.revision.slice(0, 8)}</option>
        {data.snapshots.map(s => <option value={s.id} key={s.id}>{s.revision.slice(0, 8)} · {formatDate(s.created_at)}</option>)}
      </select></Field>}
    </div>
    {importing && Boolean(data.staging && data.counts.total) && <progress className="project-import-progress" aria-label="项目导入进度" value={data.counts.indexed + data.counts.skipped + (data.counts.unavailable || 0)} max={data.counts.total} />}
    {data.status === 'ready' && canEdit && Boolean(data.counts.unavailable) &&
      <Button variant="secondary" loading={busy} onClick={() => void sync('retry-files')}><RefreshCw size={15} />补齐缺失文件</Button>}
    {(failure || error || data.error) && <ErrorBox message={failure || error || data.error} retry={data.status === 'failed' && canEdit && !busy ? () => void sync('sync') : undefined} />}
    {deleting && <Confirm title={`删除项目 ${data.repo}？`} text={deleteImpact} onClose={() => setDeleting(false)} onConfirm={async () => {
      await remove(endpoint); notify('项目已删除'); navigate('/projects');
    }} />}
    {!sid ? <section className="project-section"><Empty title={selected ? '该版本不可用' : statuses[data.status]} text={importing ? '文件正在后台导入。' : '暂时没有可阅读的版本。'} icon={<GitFork size={25} />} /></section> : <>
      <nav aria-label="项目视图" className="project-tabs">{[['route', '概览与路线'], ['files', '源码阅读'], ['ask', '项目问答'], ['links', '知识关联']].map(([key, label]) =>
        <button type="button" key={key} aria-current={view === key ? 'page' : undefined} onClick={() => changeView(key)}>{label}</button>)}</nav>
      {view === 'files' ? <Suspense fallback={<Loading />}><ProjectReader key={sid} endpoint={endpoint} sid={sid} query={query} openFile={openFile}
        scope={data.scope} onLink={setSourceLink} /></Suspense>
        : view === 'ask' ? <ProjectQuestion key={sid} endpoint={endpoint} sid={sid} openFile={openFile} />
        : view === 'links' ? <ProjectLinks endpoint={endpoint} id={id} />
        : <>
          <section className="project-section"><div className="section-heading"><h2>项目导读</h2>{canEdit && <Button variant="secondary" loading={busy} onClick={async () => {
            setBusy(true); setFailure('');
            try { setGuideResult({ snapshot: sid, answer: await post(`${endpoint}/guide`, { snapshot: sid }) }); }
            catch (e) { setFailure((e as Error).message); } finally { setBusy(false); }
          }}><Sparkles size={15} />生成导读</Button>}</div>
            {guide ? <AnswerView result={guide} openFile={openFile} /> : <p className="muted">尚无导读</p>}
          </section>
          <section className="project-section"><div className="section-heading"><h2>学习路线</h2>
            {canEdit && data.route.length > 0 && <Button variant="secondary" loading={busy} onClick={async () => {
              setBusy(true); setFailure('');
              try {
                await post('/api/plans', { title: `学习 ${data.repo}`, goal: data.objective || `项目版本 ${data.snapshot.revision.slice(0, 8)}`,
                  steps: data.route.map(step => ({ id: crypto.randomUUID(), title: step.title, done: false })) });
                notify('已加入学习计划');
              } catch (e) { setFailure((e as Error).message); } finally { setBusy(false); }
            }}><Plus size={14} />加入学习计划</Button>}</div>
            {!data.route.length && <p className="muted">该版本没有可读的文本文件。</p>}
            {data.route.map((step, i) => <RouteStep key={`${sid}:${step.id}`} endpoint={endpoint} sid={sid} step={step} number={i + 1} progress={data.progress.find(p => p.step === step.id)} openFile={openFile} onSave={() => notify('学习记录已保存')} />)}
          </section>
        </>}
    </>}
    {sourceLink && <LinkEditor endpoint={endpoint} sid={sid} file={sourceLink} close={() => setSourceLink(undefined)} />}
  </div>;
}

function RouteStep({ endpoint, sid, step, number, progress, openFile, onSave }: { endpoint: string; sid: string; step: Step; number: number; progress?: Record; openFile: (path: string) => void; onSave: () => void }) {
  const { canEdit } = useApp();
  const [stage, setStage] = useState(progress?.stage || 'todo'), [note, setNote] = useState(progress?.note || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <article className="project-step"><div className="project-step-number">{String(number).padStart(2, '0')}</div><div>
    <h3>{step.title}</h3><p>{step.task}</p>
    <ul className="project-links">{step.files.map(file => <li key={file.path}><button type="button" className="text-button" onClick={() => openFile(file.path)}><FileText size={14} />{file.path}</button></li>)}</ul>
    {canEdit ? <form className="project-progress" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try { await post(`${endpoint}/progress`, { snapshot: sid, step: step.id, stage, note }); onSave(); }
      catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}><Field label={`${step.title}进度`}><select value={stage} onChange={e => setStage(e.target.value)}>{Object.entries(stages).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      <Field label={`${step.title}笔记`}><textarea rows={2} maxLength={4000} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <Button variant="secondary" loading={busy}><Save size={14} />保存进度</Button>{error && <ErrorBox message={error} />}
    </form> : <p className="muted">{stages[stage as keyof typeof stages]}</p>}
  </div></article>;
}

function LinkEditor({ endpoint, sid, file, close }: { endpoint: string; sid: string; file: SourceRange; close: () => void }) {
  const { notify } = useApp();
  const [kind, setKind] = useState('wiki'), [target, setTarget] = useState(''), [relation, setRelation] = useState('实现');
  const [first, setFirst] = useState(file.first), [last, setLast] = useState(Math.min(file.last,file.first+119)), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const list = useData<(WikiPage | Knowledge)[]>(kind === 'wiki' ? '/api/wiki' : '/api/knowledge');
  return <Modal title="关联代码与知识" subtitle={file.path} onClose={() => { if (!busy) close(); }}>
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try { await post(`${endpoint}/links`, { snapshot: sid, path: file.path, first, last, targetType: kind, target, relation, note }); notify('代码证据已关联'); close(); }
      catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}><div className="form-columns"><Field label="起始行"><input type="number" min={1} max={file.total} value={first} onChange={e => setFirst(Number(e.target.value))} required /></Field>
      <Field label="结束行"><input type="number" min={first} max={Math.min(first+119,file.total)} value={last} onChange={e => setLast(Number(e.target.value))} required /></Field></div>
      <Field label="目标类型"><select value={kind} onChange={e => { setKind(e.target.value); setTarget(''); }}><option value="wiki">知识 Wiki</option><option value="knowledge">知识点</option></select></Field>
      <Field label="关联目标"><select required value={target} onChange={e => setTarget(e.target.value)}><option value="">{list.data?.length ? '选择已有知识' : '暂无可关联内容'}</option>{list.data?.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></Field>
      <Field label="关系"><select value={relation} onChange={e => setRelation(e.target.value)}>{['实现','先修','对比','实践'].map(v => <option key={v}>{v}</option>)}</select></Field>
      <Field label="关联说明"><textarea rows={2} maxLength={600} value={note} onChange={e => setNote(e.target.value)} /></Field>
      {(error || list.error) && <ErrorBox message={error || list.error} />}
      <div className="form-footer"><Button loading={busy} disabled={!target}><Link2 size={15} />保存关联</Button></div>
    </form>
  </Modal>;
}

type Answer = { answer: string; references: Reference[]; mode: string };
function AnswerView({ result, openFile }: { result: Answer; openFile: (path: string, line?: number) => void }) {
  return <><div className="project-answer"><RichText text={result.answer} /></div>{result.references.map((ref, i) => <details className="project-reference" key={ref.url}>
    <summary>[{i+1}] {ref.path}:{ref.first}–{ref.last}</summary><pre>{ref.text}</pre><div className="project-actions">
      <Button variant="secondary" onClick={() => openFile(ref.path, ref.first)}>阅读代码</Button>
      <a href={ref.url} target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={13} /></a>
    </div></details>)}</>;
}
function ProjectQuestion({ endpoint, sid, openFile }: { endpoint: string; sid: string; openFile: (path: string, line?: number) => void }) {
  const { canEdit } = useApp();
  const [question, setQuestion] = useState(''), [scope, setScope] = useState('');
  const [result, setResult] = useState<Answer>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section className="project-section"><h2>项目问答</h2>
    {canEdit && <form className="project-question" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try { setResult(await post(`${endpoint}/ask`, { snapshot: sid, question, scope })); }
      catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}><Field label="问题"><textarea rows={3} required maxLength={800} value={question} onChange={e => setQuestion(e.target.value)} /></Field>
      <Field label="目录或文件范围（可选）"><input maxLength={1000} value={scope} onChange={e => setScope(e.target.value)} placeholder="src/" /></Field>
      <Button loading={busy}><Search size={15} />查找证据并回答</Button></form>}
    {error && <ErrorBox message={error} />}{result && <AnswerView result={result} openFile={openFile} />}
  </section>;
}
function ProjectLinks({ endpoint, id }: { endpoint: string; id: string }) {
  const { data, error, loading } = useData<ProjectLink[]>(`${endpoint}/links`);
  return <section className="project-section"><h2>知识关联</h2>{error ? <ErrorBox message={error} /> : loading ? <Loading /> : !data?.length ? <p className="muted">暂无关联</p> : <ul className="project-links project-link-list">
    {data.map(link => <li key={link.id}><a href={`#${projectPath(id, link.snapshot_id, link.path, link.first)}`}>{link.path}:{link.first}–{link.last}</a>
      <Badge tone="mint">{link.relation}</Badge><a href={link.wiki_id ? `#/wiki/${link.wiki_id}` : `#/knowledge?focus=${link.knowledge_id}`}>{link.title}<ArrowUpRight size={13} /></a>
      <small>{link.revision.slice(0, 8)}{link.note && ` · ${link.note}`}</small></li>)}
  </ul>}</section>;
}
