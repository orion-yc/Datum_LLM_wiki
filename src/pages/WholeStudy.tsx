import WikiSystemPicker, { type SystemChoice } from './WikiSystemPicker';
import { MathText } from '../MathText';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Pause, Sparkles } from 'lucide-react';
import { api, post, useData, navigate } from '../api';
import { Button, ErrorBox, Loading, Modal, Notice, Progress, useApp } from '../ui';

import BookStudy from './BookStudy';

type Part = { id: string; first: number; last: number; saved: boolean; title?: string; summary?: string };
type Guide = { parts: Part[]; configured: boolean; system_id?: string | null };

export type StudyProps = {
  sourceId: string; title?: string; pdf: boolean; onClose: () => void; onCustom: () => void; onPaper: (system?: SystemChoice) => void; initialSystem?: SystemChoice;
};

export default function WholeStudy(props: StudyProps) {
  const [segmented, setSegmented] = useState(false);
  return segmented ? <SegmentStudy {...props} onBook={() => setSegmented(false)} />
    : <BookStudy {...props} onSegmented={() => setSegmented(true)} />;
}

function SegmentStudy({ sourceId, title, pdf, onClose, onCustom, initialSystem, onBook }: StudyProps & {onBook: () => void}) {
  const { refresh } = useApp();
  const [pendingSystem, setPendingSystem] = useState(false);
  const [systemId, setSystemId] = useState<SystemChoice>(initialSystem);
  const endpoint = `/api/wiki/study/${sourceId}`;
  const [revision, setRevision] = useState(0);
  const { data, setData, loading, error } = useData<Guide>(endpoint, revision);
  const [busyId, setBusyId] = useState(''), [pausing, setPausing] = useState(false), [failure, setFailure] = useState('');
  const active = useRef(false), stop = useRef(false), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop.current = true; };
  }, []);

  function leave(action: () => void) {
    stop.current = true;
    action();
  }

  async function run() {
    if (active.current) return;
    active.current = true;
    stop.current = false;
    setPausing(false);
    setFailure('');
    setBusyId('loading');
    try {
      const guide = await api<Guide>(endpoint);
      if (!mounted.current || stop.current) return;
      setData(guide);
      if (!guide.configured) return;
      const target = guide.parts.some(p => p.saved) ? guide.system_id : systemId;
      for (const part of guide.parts) {
        if (stop.current || !mounted.current) break;
        if (part.saved) continue;
        setBusyId(part.id);
        const saved = await post<Pick<Part, 'id' | 'title' | 'summary'> & {system_id?: string | null}>(endpoint, { part_id: part.id, system_id: target });
        if (!mounted.current) break;
        setData(current => current && ({
          ...current, system_id: saved.system_id ?? current.system_id ?? target, parts: current.parts.map(p => p.id === part.id ? { ...p, ...saved, saved: true } : p),
        }));
      }
    } catch (err) {
      if (mounted.current) setFailure((err as Error).message);
    } finally {
      active.current = false;
      if (mounted.current) {
        setBusyId('');
        setPausing(false);
        setRevision(n => n + 1);
      }
      refresh();
    }
  }

  const done = data?.parts.filter(p => p.saved) || [];
  const total = data?.parts.length || 0;
  const range = (p: Part) => `第 ${p.first === p.last ? p.first : `${p.first}–${p.last}`} ${pdf ? '页' : '节'}`;
  return <Modal title="全文导读" subtitle={title} wide onClose={() => leave(onClose)}>
    <div className="section-heading"><h3>按原文顺序学习</h3>
      <Button variant="ghost" disabled={Boolean(busyId)} onClick={() => leave(onBook)}>按书籍目录整理</Button><Button variant="ghost" disabled={Boolean(busyId)} onClick={() => leave(onCustom)}>改为自选主题</Button>
    </div>
    {loading && !data && <Loading />}
    {error && <ErrorBox message={error} retry={() => setRevision(n => n + 1)} />}
    {data && <>
      <p className="muted small">每段生成一篇 Wiki 草稿，串起概念、原理和原文例子。整理期间请保持窗口打开，已保存的部分可随时继续阅读。</p>
      <WikiSystemPicker onPending={setPendingSystem} value={done.length ? data.system_id : systemId} allowAuto={!done.length || data.system_id === undefined} disabled={Boolean(busyId || done.length)} onChange={setSystemId} />
      <p aria-live="polite">已保存 {done.length} / {total} 段</p>
      <Progress value={total ? Math.round(done.length / total * 100) : 0} />
      <ol className="study-outline" aria-label="全文导读目录">
        {data.parts.map(p => <li key={p.id}>
          <div><small>{range(p)}</small>{p.saved
            ? <><a className="text-button" href={`#/wiki/${p.id}`} onClick={() => leave(onClose)}><MathText text={p.title || ''} /><ArrowUpRight size={14} /></a><p><MathText text={p.summary || ''} /></p></>
            : <span>{busyId === p.id ? '正在整理…' : '待整理'}</span>}</div>
        </li>)}
      </ol>
      {!data.configured && done.length < total && <Notice>请先在空间设置中连接模型，再生成导读。</Notice>}
    </>}
    {failure && <ErrorBox message={failure} />}
    <div className="form-footer">
      <Button variant="secondary" onClick={() => leave(onClose)}>关闭</Button>
      {busyId
        ? <Button variant="secondary" disabled={pausing} onClick={() => { stop.current = true; setPausing(true); }}><Pause size={15} />{pausing ? '将在本段完成后暂停' : '完成本段后暂停'}</Button>
        : done.length && done.length === total ? <Button onClick={() => leave(() => { onClose(); navigate(`/wiki/${done[0].id}`); })}><BookOpen size={15} />阅读第一篇</Button>
        : <Button disabled={!data?.configured || !total || pendingSystem} onClick={run}><Sparkles size={15} />{done.length || failure ? '继续整理' : '开始全文整理'}</Button>}
    </div>
  </Modal>;
}
