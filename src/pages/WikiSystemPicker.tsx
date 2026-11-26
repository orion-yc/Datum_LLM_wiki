import { useState } from 'react';
import { post, useData } from '../api';
import type { WikiSystem } from '../types';
import { Button, ErrorBox, Field } from '../ui';

export type SystemChoice = string | null | undefined;

export default function WikiSystemPicker({ value, onChange, allowAuto = true, disabled = false, onPending }: {
  value: SystemChoice; onChange: (id: SystemChoice) => void; allowAuto?: boolean; disabled?: boolean; onPending: (pending: boolean) => void;
}) {
  const [revision, setRevision] = useState(0), [creating, setCreating] = useState(false);
  const [name, setName] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const { data: systems, error: loadError } = useData<WikiSystem[]>('/api/wiki/systems', revision);
  async function create() {
    if (saving || !name.trim()) return;
    setSaving(true); setError('');
    try {
      const system = await post<WikiSystem>('/api/wiki/systems', { title: name.trim() });
      setRevision(n => n + 1); onChange(system.id); setCreating(false); onPending(false); setName('');
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  return <div>
    <Field label="所属知识体系"><select disabled={disabled || saving} value={creating ? 'new' : value === undefined ? 'auto' : value ?? 'unassigned'}
      onChange={e => {
        setError(''); setCreating(e.target.value === 'new'); onPending(e.target.value === 'new');
        if (e.target.value !== 'new') onChange(e.target.value === 'auto' ? undefined : e.target.value === 'unassigned' ? null : e.target.value);
      }}>
      {allowAuto && <option value="auto">按来源归组</option>}
      <option value="unassigned">待归类</option>
      {systems?.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
      {!disabled && <option value="new">新建知识体系…</option>}
    </select></Field>
    {creating && <div className="form-columns"><Field label="新体系名称"><input maxLength={200} value={name} disabled={disabled || saving}
      onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void create(); } }} /></Field>
      <div><Button type="button" variant="secondary" disabled={!name.trim() || disabled} loading={saving} onClick={create}>创建并选用</Button></div></div>}
    {(error || loadError) && <ErrorBox message={error || loadError} />}
  </div>;
}
