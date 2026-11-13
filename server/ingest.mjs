import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, dataDir, all, one, run, id, now, activity, transaction } from './db.mjs';
import { splitText, markdownChunks } from './retrieval.mjs';

const queue = [];
let running = false;
export function enqueue(sourceId) { if (!queue.includes(sourceId)) queue.push(sourceId); void drain(); }
async function drain() {
  if (running) return;
  running = true;
  try { while (queue.length) await ingest(queue.shift()); } finally { running = false; }
}
async function ingest(sourceId) {
  const source = one('SELECT * FROM sources WHERE id=?', sourceId);
  if (!source) return;
  run("UPDATE sources SET status='processing',progress=5,error='',updated_at=? WHERE id=?", now(), sourceId);
  try {
    const file = await readFile(join(dataDir, 'uploads', source.id));
    let chunks = [], pages = 0;
    if (source.type === 'pdf') {
      if (file.subarray(0, 5).toString() !== '%PDF-') throw new Error('文件内容不是有效的 PDF，请检查文件后重新上传。');
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const assetPath = directory => fileURLToPath(new URL(`./${directory}/`, import.meta.resolve('pdfjs-dist/package.json'))).replaceAll('\\', '/');
      const task = getDocument({ data: new Uint8Array(file), isEvalSupported: false, useSystemFonts: true, stopAtErrors: true, cMapUrl: assetPath('cmaps'), cMapPacked: true, standardFontDataUrl: assetPath('standard_fonts'), wasmUrl: assetPath('wasm') });
      let pdf;
      try {
        pdf = await task.promise;
        pages = pdf.numPages;
        if (pages > 2000) throw new Error('第一版单份 PDF 最多支持 2000 页，请拆分后上传。');
        for (let p = 1; p <= pages; p++) {
          const page = await pdf.getPage(p);
          const content = await page.getTextContent();
          const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
          for (const part of splitText(text)) chunks.push({ page: p, heading: `第 ${p} 页`, content: part });
          if (p % 8 === 0) run('UPDATE sources SET progress=? WHERE id=?', Math.min(95, 5 + Math.round(p / pages * 90)), sourceId);
          page.cleanup();
        }
      } finally { await task.destroy(); }
    } else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file);
      chunks = markdownChunks(text);
      pages = chunks.length;
    }
    if (!chunks.length || chunks.reduce((n, c) => n + c.content.trim().length, 0) < 8) throw new Error('未提取到可阅读的正文。扫描版 PDF 需先完成 OCR；文本文件请使用 UTF-8 编码。');
    if (chunks.length > 15000) throw new Error('资料内容过长，请拆分为多个文件后上传。');
    if (!one('SELECT id FROM sources WHERE id=?', sourceId)) return;
    transaction(() => {
      run('DELETE FROM chunks WHERE source_id=?', sourceId);
      const insert = db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?)');
      chunks.forEach((c, i) => insert.run(id(), sourceId, c.page, c.heading, c.content, i));
      run("UPDATE sources SET status='ready',progress=100,pages=?,error='',updated_at=? WHERE id=?", pages, now(), sourceId);
      activity('source', `导入了《${source.title}》`);
    });
  } catch (error) {
    const message = error.name === 'PasswordException' ? 'PDF 需要密码，请上传解除密码保护的版本。' : error instanceof TypeError ? '无法读取正文，请确认文本为 UTF-8 编码或 PDF 内容完整。' : String(error.message).slice(0, 400);
    run("UPDATE sources SET status='failed',progress=0,error=?,updated_at=? WHERE id=?", message, now(), sourceId);
  }
}
export function resumeImports() { for (const s of all("SELECT id FROM sources WHERE status='processing' ORDER BY created_at")) enqueue(s.id); }

export const sampleText = `# 二分查找学习手记

这是一份知序自带的原创示例资料，用于体验上传后的阅读、知识点、引用问答和复习流程。可以随时删除。

## 二分查找的前提

二分查找适用于有序序列。每次比较中间元素，将候选区间缩小约一半。没有排序保证时，不能直接套用二分查找。时间复杂度为 O(log n)，迭代实现通常只需 O(1) 的额外空间。

## 闭区间与循环边界

对于闭区间 [left, right]，初始 left = 0，right = n - 1。循环条件为 left <= right，因为 left 等于 right 时还有一个候选元素。mid = left + Math.floor((right - left) / 2)。若目标小于中间值，令 right = mid - 1；若目标大于中间值，令 left = mid + 1。每次更新都排除已经比较的中间位置。

## 左闭右开区间

对于左闭右开区间 [left, right)，初始 right = n，循环条件为 left < right。左闭右开区间为空时 left 等于 right。具体更新方式必须与查找目标和循环不变量保持一致，不能混用另一种区间的写法。

## 用实践验证理解

实现查找函数，并检查空数组、单个元素、首尾元素、目标不存在和重复元素。查找任意相等元素与查找第一个相等元素是不同任务，后者需要继续缩小区间。解释循环不变量，并用例子验证终止条件。
`;
