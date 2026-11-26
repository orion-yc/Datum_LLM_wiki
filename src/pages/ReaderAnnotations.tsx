import { useState, type RefObject } from 'react';
import { TextSelectionActions } from './TextSelectionActions';
import { Link2, StickyNote } from 'lucide-react';
import { post } from '../api';
import { readSelection, type ReaderSelection } from '../readerSelection';
import type { Knowledge } from '../types';
import { Button, ErrorBox, Field, Modal, useApp } from '../ui';

export function SelectionToolbar({ paper, onAction }: {
  paper: RefObject<HTMLElement | null>;
  onAction: (type: 'note' | 'link', selection: ReaderSelection) => void;
}) {
  return <TextSelectionActions paper={paper} read={readSelection} margin={106}>{selection => <>
    <button onClick={() => onAction('note', selection)}><StickyNote size={15} />记笔记</button>
    <button onClick={() => onAction('link', selection)}><Link2 size={15} />关联知识点</button>
  </>}</TextSelectionActions>;
}

export function KnowledgeLinkEditor({ sourceId, selection, knowledge, onClose }: {
  sourceId: string; selection: ReaderSelection; knowledge: Knowledge[]; onClose: () => void;
}) {
  const { notify, refresh } = useApp();
  const [creating, setCreating] = useState(!knowledge.length);
  const [knowledgeId, setKnowledgeId] = useState(''), [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title="关联知识点" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        await post(`/api/sources/${sourceId}/knowledge-links`, { selection, ...(creating
          ? { new_knowledge: { title: title.trim(), summary: selection.quote } } : { knowledge_id: knowledgeId }) });
        refresh(); notify('原文已关联到知识点。'); onClose();
      } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}>
      <blockquote className="reader-quote">{selection.quote}</blockquote>
      {knowledge.length > 0 && <div className="tabs reader-link-mode">
        <button type="button" className={!creating ? 'active' : ''} onClick={() => setCreating(false)}>已有知识点</button>
        <button type="button" className={creating ? 'active' : ''} onClick={() => setCreating(true)}>新建知识点</button>
      </div>}
      {creating ? <Field label="知识点名称"><input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></Field>
        : <Field label="选择知识点"><select autoFocus required value={knowledgeId} onChange={e => setKnowledgeId(e.target.value)}>
          <option value="">请选择</option>{knowledge.map(k => <option key={k.id} value={k.id}>{k.title}</option>)}
        </select></Field>}
      {error && <ErrorBox message={error} />}
      <div className="form-footer"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" disabled={creating ? !title.trim() : !knowledgeId} loading={busy}>保存关联</Button></div>
    </form>
  </Modal>;
}
