import { api, ApiError, post } from './api';

export const MAX_FILE_BYTES = 250 * 1024 * 1024;
const MULTIPART_FILE_BYTES = 30 * 1024 * 1024;
type Parsing = { parseMode: 'ai' | 'standard'; aiPages: number; aiAll?: boolean };
type Batch = { id: string; chunkSize: number; maxChunkSize?: number };
let pending: { files: File[]; key: string; batch: Batch } | undefined;

async function retry<T>(action: () => Promise<T>, progress: (value: string) => void, onRetry?: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      const transient = error instanceof TypeError || (error instanceof ApiError && [408, 429, 500, 502, 503, 504, 520, 522, 524].includes(error.status));
      if (!transient || attempt >= 3) throw error;
      onRetry?.();
      progress(`网络波动，正在重试（${attempt + 1}/3）…`);
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

export async function uploadSources(files: File[], category: string, progress: (value: string) => void,
  parsing: Parsing = { parseMode: 'standard', aiPages: 10 }) {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= 32 * 1024 * 1024 && files.every(file => file.size <= MULTIPART_FILE_BYTES)) {
    const form = new FormData();
    form.append('category', category);
    form.append('parseMode', parsing.parseMode);
    if (parsing.aiAll) form.append('aiAll', '1');
    if (parsing.parseMode === 'ai') form.append('aiPages', String(parsing.aiPages));
    files.forEach(file => form.append('files', file));
    progress('正在上传并解析…');
    return api('/api/sources/upload', { method: 'POST', body: form });
  }
  const key = JSON.stringify({ category, ...parsing });
  if (!pending || pending.key !== key || files.length !== pending.files.length || files.some((file, i) => file !== pending!.files[i])) {
    const batch = await post<Batch>('/api/uploads', {
      category, ...parsing, files: files.map(file => ({ name: file.name, size: file.size })),
    });
    pending = { files: [...files], key, batch };
  }
  const batch = pending.batch;
  try {
    const status = await retry(() => api<{ offsets: number[] }>(`/api/uploads/${batch.id}`), progress);
    let blockSize = Math.min(batch.chunkSize, 1024 * 1024);
    const maxBlockSize = Math.min(batch.maxChunkSize ?? batch.chunkSize, 4 * 1024 * 1024);
    let sent = status.offsets.reduce((sum, size) => sum + size, 0);
    for (const [index, file] of files.entries()) {
      for (let offset = status.offsets[index]; offset < file.size;) {
        let chunk = file.slice(offset, offset + blockSize);
        const started = performance.now();
        let retried = false;
        const result = await retry(() => api<{ offset: number }>(`/api/uploads/${batch.id}/${index}?offset=${offset}`, {
          method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream' },
        }), progress, () => {
          retried = true; blockSize = 1024 * 1024;
          chunk = file.slice(offset, offset + blockSize);
        });
        if (result.offset !== offset + chunk.size) throw new Error('服务器上传进度不一致，请重试。');
        sent += chunk.size; offset = result.offset;
        const elapsed = Math.max(1, performance.now() - started);
        const speed = chunk.size / elapsed * 1000;
        if (!retried && elapsed < 2000) blockSize = Math.min(maxBlockSize, blockSize * 2);
        else if (elapsed > 8000) blockSize = Math.max(1024 * 1024, Math.floor(blockSize / 2));
        const seconds = Math.ceil((total - sent) / speed);
        progress(`正在上传 ${Math.floor(sent / total * 100)}% · ${(speed / 1024 / 1024).toFixed(1)} MB/s · 约剩 ${seconds} 秒`);
      }
    }
    progress('上传完成，正在解析资料…');
    const result = await post(`/api/uploads/${batch.id}/complete`);
    pending = undefined;
    return result;
  } catch (error) {
    if (error instanceof ApiError && [404, 410].includes(error.status)) pending = undefined;
    throw new Error(`${(error as Error).message} 上传进度已保留；保持当前文件选择，再点上传可继续。`);
  }
}
