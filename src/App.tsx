import { useCallback, useEffect, useState } from 'react';
import { BookOpen, LayoutDashboard, Library as LibraryIcon, Brain, Route, MessageSquare, GraduationCap, Settings2, Search, Plus, LogOut, ChevronRight, ArrowUpRight, Menu, X, Sparkles, CheckCircle2, AlertCircle, ShieldCheck, ArrowRight, Eye, EyeOff, FileText, Command } from 'lucide-react';
import { api, useData, post, navigate, useRoute, fileSize } from './api';
import { AppContext, Button, Modal, Loading, ErrorBox, Field, Empty } from './ui';
import type { Source, Chunk, Knowledge, Dashboard, WikiPage } from './types';
import Home from './pages/Home';
import Auth from './pages/Auth';
import TeamPage from './pages/Team';
import Papers from './pages/Papers';
import Wiki from './pages/Wiki';
import Projects from './pages/Projects';
import { GitFork } from 'lucide-react';
import { ROLE_LABELS, type AuthState } from './types';
import Library, { UploadModal, Reader } from './pages/Library';
import KnowledgePage from './pages/Knowledge';
import Plans from './pages/Plans';
import Chat from './pages/Chat';
import PracticePage from './pages/Practice';
import Settings from './pages/Settings';

const navigation = [
  { id: 'home', path: '/', label: '学习首页', icon: LayoutDashboard },
  { id: 'library', path: '/library', label: '我的资料库', icon: LibraryIcon },
  { id: 'projects', path: '/projects', label: '互联网学习', icon: GitFork },
  { id: 'wiki', path: '/wiki', label: '知识 Wiki', icon: BookOpen },
  { id: 'knowledge', path: '/knowledge', label: '知识与技能', icon: Brain },
  { id: 'plans', path: '/plans', label: '学习计划', icon: Route },
  { id: 'chat', path: '/chat', label: '和知识对话', icon: MessageSquare },
  { id: 'papers', path: '/papers', label: '论文研究', icon: FileText },
  { id: 'team', path: '/team', label: '团队协作', icon: ShieldCheck },
  { id: 'practice', path: '/practice', label: '练习与复习', icon: GraduationCap },
];
function Brand() { return <div className="brand"><span className="brand-icon"><BookOpen size={25} strokeWidth={1.7} /></span><div><strong>知序<span>Beta</span></strong><small>KNOWLEDGE STUDIO</small></div></div>; }

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null), [authError, setAuthError] = useState(''), [revision, setRevision] = useState(0), [uploadOpen, setUploadOpen] = useState(false), [searchOpen, setSearchOpen] = useState(false), [mobileNav, setMobileNav] = useState(false), [toast, setToast] = useState<{ text: string; kind: string } | null>(null);
  const route = useRoute();
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  const notify = useCallback((text: string, kind: 'success' | 'error' = 'success') => setToast({ text, kind }), []);
  const checkAuth = useCallback(async () => { try { setAuth(await api('/api/auth')); setAuthError(''); } catch (e) { setAuthError((e as Error).message); } }, []);
  useEffect(() => { void checkAuth(); const expired = () => { setAuth(a => a ? { ...a, authenticated: false } : null); }; window.addEventListener('auth-expired', expired); return () => window.removeEventListener('auth-expired', expired); }, [checkAuth]);
  useEffect(() => { if (!auth?.authenticated) return; void checkAuth(); const timer = setInterval(() => void checkAuth(), 30000); return () => clearInterval(timer); }, [revision, auth?.authenticated, checkAuth]);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); if (auth?.authenticated) setSearchOpen(v => !v); } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [auth?.authenticated]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.kind === 'error' ? 7000 : 4200); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { setMobileNav(false); document.title = `${navigation.find(n => n.id === route.page)?.label || (route.page === 'settings' ? '空间设置' : '知序')} · 知序`; }, [route.pathname]);
  const { data: dashboard } = useData<Dashboard>(auth?.authenticated ? '/api/dashboard' : null, revision);
  if (authError) return <div className="boot-error"><Brand /><ErrorBox message={authError} retry={checkAuth} /></div>;
  if (!auth) return <div className="boot-loading"><Brand /><Loading /></div>;
  if (!auth.authenticated || route.page === 'join') return <Auth initialized={auth.initialized} onComplete={checkAuth} token={route.page === 'join' ? route.query.get('token') || undefined : undefined} />;
  const canEdit = auth.user?.role !== 'viewer', isAdmin = ['owner','admin'].includes(auth.user?.role || '');
  return <AppContext.Provider value={{ revision, refresh, notify, upload: () => setUploadOpen(true), user: auth.user, canEdit, isAdmin }}><div className="app-shell">{mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}<aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}><Brand /><div className="workspace-label"><span className="workspace-dot" />{auth.teamName}<span className="workspace-private">{ROLE_LABELS[auth.user?.role || 'viewer']}</span></div><div className="nav-label">学习工作台</div><nav aria-label="主要功能">{navigation.map(item => <button key={item.id} className={`nav-item ${route.page === item.id ? 'active' : ''}`} onClick={() => navigate(item.path)}><item.icon size={19} strokeWidth={1.7} /><span>{item.label}</span>{item.id === 'practice' && Boolean(dashboard?.stats.due) && <span className="nav-count">{dashboard?.stats.due}</span>}{route.page === item.id && <span className="nav-active-dot" />}</button>)}</nav><div className="nav-divider" /><button className={`nav-item ${route.page === 'settings' ? 'active' : ''}`} onClick={() => navigate('/settings')}><Settings2 size={19} strokeWidth={1.7} /><span>空间设置</span></button><div className="sidebar-bottom"><div className="sidebar-note"><div><Sparkles size={18} /><span>把时间，留给理解</span></div><p>一点阅读，一点实践。<br />你的知识，正在慢慢生长。</p><button onClick={() => navigate('/plans')}>规划下一步<ArrowUpRight size={14} /></button></div><div className="sidebar-storage"><span>我的资料空间</span><span>{fileSize(dashboard?.stats.storage || 0)}</span></div><div className="user-area"><div className="user-avatar">知</div><div><strong>{auth.user?.name}</strong><small><span className={`status-dot ${dashboard?.model.configured ? 'connected' : ''}`} />{dashboard?.model.configured ? '模型已连接配置' : '本地资料模式'}</small></div><button className="icon-button" aria-label="退出登录" title="退出登录" onClick={async () => { try { await post('/api/auth/logout'); setAuth({ initialized: true, authenticated: false }); } catch (e) { notify((e as Error).message, 'error'); } }}><LogOut size={16} /></button></div></div></aside><div className="main-shell"><header className="topbar"><button className="icon-button mobile-menu" aria-label="展开导航" onClick={() => setMobileNav(!mobileNav)}><Menu size={21} /></button><div className="breadcrumb"><span>{auth.teamName}</span><ChevronRight size={13} /><strong>{navigation.find(n => n.id === route.page)?.label || '空间设置'}</strong></div><div className="topbar-actions"><button className="global-search" onClick={() => setSearchOpen(true)}><Search size={17} /><span>搜索你的知识…</span><kbd>Ctrl K</kbd></button><div className="topbar-separator" /><button disabled={!canEdit} className="top-add" onClick={() => setUploadOpen(true)} aria-label="添加资料"><Plus size={18} /></button><div className="top-avatar" aria-hidden="true">知</div></div></header><main className={`page-content ${!canEdit ? 'readonly-mode' : ''} ${route.page === 'library' && route.id ? 'reader-page' : ''}`} key={route.page}>{!canEdit && <div className="readonly-banner">你正在以只读成员身份浏览团队空间。</div>}{route.page === 'home' ? <Home /> : route.page === 'library' ? route.id ? <Reader key={route.id} sourceId={route.id} chunkId={route.query.get('chunk')} linkId={route.query.get('link')} from={route.query.get('from')} /> : <Library /> : route.page === 'projects' ? <Projects key={route.id} id={route.id} query={route.query} /> : route.page === 'wiki' ? <Wiki key={route.query.get('system') || 'wiki'} bookKey={route.query.get('book')} cardsView={route.query.get('view') === 'cards'} id={route.id} sourceId={route.query.get('source')} systemKey={route.query.get('system')} /> : route.page === 'knowledge' ? <KnowledgePage focus={route.query.get('focus')} /> : route.page === 'plans' ? <Plans /> : route.page === 'chat' ? <Chat conversationId={route.id} /> : route.page === 'practice' ? <PracticePage initialKnowledge={route.query.get('knowledge')} /> : route.page === 'papers' ? <Papers comparisonId={route.id} /> : route.page === 'team' ? <TeamPage /> : route.page === 'settings' ? <Settings /> : <Empty title="没有找到这个页面" text="回到学习首页，继续自己的积累。" action={<Button onClick={() => navigate('/')}>返回首页</Button>} />}</main><footer className="app-footer"><span>知序 · 让每一次学习都有迹可循</span><span>Collect. Connect. Grow.</span></footer></div></div>{uploadOpen && <UploadModal onClose={() => setUploadOpen(false)} />}{searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}{toast && <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>{toast.kind === 'error' ? <AlertCircle size={19} /> : <CheckCircle2 size={19} />}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={16} /></button></div>}</AppContext.Provider>;
}
function SearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState(''), [debounced, setDebounced] = useState('');
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  const { data, error, loading } = useData<{ sources: Source[]; knowledge: Knowledge[]; chunks: Chunk[]; wiki: WikiPage[] }>(debounced ? `/api/search?q=${encodeURIComponent(debounced)}` : null);
  const go = (path: string) => { navigate(path); onClose(); };
  return <Modal title="搜索你的知识" subtitle="搜索 Wiki 知识页、资料、知识点与原文证据。" onClose={onClose} wide><div className="input-icon modal-search"><Search size={20} /><input aria-label="全局搜索" placeholder="试试一个概念、一本书或一个关键词…" value={query} maxLength={200} onChange={e => setQuery(e.target.value)} /></div><div className="search-results">{error ? <ErrorBox message={error} /> : loading && debounced ? <Loading /> : data ? <>{data.wiki?.length > 0 && <><h4>Wiki 知识页</h4>{data.wiki.map(p => <button className="search-result" key={p.id} onClick={() => go(`/wiki/${p.id}`)}><BookOpen size={18} /><div><strong>{p.title}</strong><small>{p.status === 'published' ? '已发布' : '草稿'} · {p.summary.slice(0, 100)}</small></div><ArrowUpRight size={15} /></button>)}</>}{data.sources.length > 0 && <><h4>资料</h4>{data.sources.map(s => <button className="search-result" key={s.id} onClick={() => go(`/library/${s.id}`)}><BookOpen size={18} /><div><strong>{s.title}</strong><small>{s.category}</small></div><ArrowUpRight size={15} /></button>)}</>}{data.knowledge.length > 0 && <><h4>知识点</h4>{data.knowledge.map(k => <button className="search-result" key={k.id} onClick={() => go(`/knowledge?focus=${k.id}`)}><Brain size={18} /><div><strong>{k.title}</strong><small>{k.summary.slice(0, 80)}</small></div><ArrowUpRight size={15} /></button>)}</>}{data.chunks.length > 0 && <><h4>原文片段</h4>{data.chunks.map(c => <button className="search-result" key={c.id} onClick={() => go(`/library/${c.source_id}?chunk=${c.id}`)}><FileText size={18} /><div><strong>{c.source_title} / {c.heading}</strong><small>{c.content.slice(0, 120)}</small></div><ArrowUpRight size={15} /></button>)}</>}{!data.sources.length && !data.knowledge.length && !data.chunks.length && !data.wiki?.length && <div className="subtle-empty">没有找到相关内容，请换一个关键词。</div>}</> : <div className="search-initial"><Search size={30} strokeWidth={1.3} /><p>让已经学过的知识，再次被找到。</p></div>}</div></Modal>;
}
