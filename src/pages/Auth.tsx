import { useState } from 'react';
import { BookOpen, ShieldCheck, ArrowRight } from 'lucide-react';
import { post, useData, navigate } from '../api';
import { Button, Field, ErrorBox, Loading } from '../ui';
import { ROLE_LABELS, type Role } from '../types';

export default function Auth({ initialized, onComplete, token }: { initialized: boolean; onComplete: () => Promise<void>; token?: string }) {
  const [username, setUsername] = useState(token ? '' : 'admin'), [name, setName] = useState(''), [teamName, setTeamName] = useState('我的学习空间');
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { data: invitation, error: invitationError, loading } = useData<{ teamName: string; role: Role }>(token ? `/api/auth/invitation?token=${encodeURIComponent(token)}` : null);
  const creating = !initialized || Boolean(token);
  return <div className="auth-page"><div className="auth-story"><div className="brand"><span className="brand-icon"><BookOpen size={25} /></span><div><strong>知序<span>Beta</span></strong><small>KNOWLEDGE STUDIO</small></div></div><div className="auth-story-content"><span className="eyebrow">LEARN TOGETHER, THINK DEEPER</span><h1>连接知识，<br />汇集思考，<br /><span>一起向前。</span></h1><p>让阅读有依据，让协作有方向。<br />构建属于你们的知识空间。</p></div></div><div className="auth-form-side"><div className="auth-form"><div className="auth-form-icon"><ShieldCheck size={28} /></div><h2>{token ? `加入${invitation?.teamName || '团队'}` : initialized ? '欢迎回到知序' : '开启你的知识空间'}</h2><p>{token && invitation ? `邀请角色：${ROLE_LABELS[invitation.role]}。请创建独立账号。` : initialized ? '使用你的成员账号登录。旧版空间的默认账号为 admin。' : '创建空间所有者，之后可邀请团队成员。'}</p>{token && loading ? <Loading /> : invitationError ? <ErrorBox message={invitationError} /> : <form onSubmit={async e => { e.preventDefault(); setError(''); if (creating && password !== confirm) { setError('两次输入的密码不一致。'); return; } setBusy(true); try { await post(token ? '/api/auth/join' : initialized ? '/api/auth/login' : '/api/auth/setup', { username, name: name || '空间所有者', teamName, password, token }); await onComplete(); if (token) navigate('/team'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
    <Field label="成员账号" hint="3–40 位字母、数字、点、下划线或短横线。"><input required minLength={3} maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,39}" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" /></Field>
    {creating && <Field label="显示姓名"><input required maxLength={80} value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></Field>}
    {!initialized && !token && <Field label="空间名称"><input required maxLength={80} value={teamName} onChange={e => setTeamName(e.target.value)} /></Field>}
    <Field label={creating ? '设置访问密码' : '访问密码'}><input required minLength={8} maxLength={200} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={creating ? 'new-password' : 'current-password'} placeholder="至少 8 个字符" /></Field>
    {creating && <Field label="确认访问密码"><input required type="password" minLength={8} maxLength={200} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" /></Field>}
    {error && <ErrorBox message={error} />}<Button className="full auth-submit" loading={busy}>{token ? '创建账号并加入团队' : initialized ? '进入我的知识空间' : '创建我的知识空间'}<ArrowRight size={17} /></Button></form>}<div className="auth-foot"><ShieldCheck size={14} />资料与协作记录保存在你的服务器上</div></div></div></div>;
}
