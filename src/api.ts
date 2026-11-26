import { useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const form = options.body instanceof FormData;
  const response = await fetch(path, { ...options, headers: { ...(!form && options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => null);
  if (response.status === 401 && !path.startsWith('/api/auth')) window.dispatchEvent(new Event('auth-expired'));
  if (data === null) {
    throw new ApiError(response.status === 504 || response.status === 524
      ? '上传或处理请求超时，请重试；已保存的分块会保留。'
      : `服务器响应异常（HTTP ${response.status}），请稍后重试。`, response.status);
  }
  if (!response.ok) {
    throw new ApiError(data.error || `请求未完成（${response.status}）`, response.status);
  }
  return data;
}
export const post = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const remove = (path: string) => api(path, { method: 'DELETE' });
export function useData<T>(path: string | null, revision = 0, poll = 0) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!path) { setData(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    const load = async () => {
      try { const result = await api<T>(path, { signal: controller.signal }); if (!controller.signal.aborted) { setData(result); setError(''); } }
      catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void load(); const interval = poll ? window.setInterval(load, poll) : undefined;
    return () => { controller.abort(); if (interval) clearInterval(interval); };
  }, [path, revision, poll]);
  return { data, error, loading, setData };
}
export function navigate(path: string) { window.location.hash = path; }
export function useRoute() {
  const [route, setRoute] = useState(window.location.hash.slice(1) || '/');
  useEffect(() => { const update = () => setRoute(window.location.hash.slice(1) || '/'); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  const [pathname, query = ''] = route.split('?');
  return { pathname, page: pathname.split('/')[1] || 'home', id: pathname.split('/')[2] || '', query: new URLSearchParams(query) };
}
export const formatDate = (value?: string | null) => value ? new Date(value.includes('T') ? value : value + 'T00:00:00').toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '未设置';
export function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function fileSize(bytes: number) { return bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
