import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import assert from 'node:assert/strict';
import { open, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testServer, projectRoot } from '../tests/helpers.mjs';

const size = 207952623; // Exact size of the reported textbook.
const temp = await mkdtemp(join(tmpdir(), 'datum-large-upload-'));
const server = await testServer();
let browser;
try {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('Large textbook upload regression.', { font });
  const original = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const start = original.lastIndexOf('startxref');
  const path = join(temp, '198MB.pdf');
  const output = await open(path, 'w');
  try {
    // Sparse PDF whitespace before startxref preserves the original cross-reference offsets.
    await output.write(original.subarray(0, start), 0, start, 0);
    const tail = original.subarray(start);
    await output.write(tail, 0, tail.length, size - tail.length);
  } finally { await output.close(); }
  const createSparse = async (name, bytes) => {
    const path = join(temp, name), file = await open(path, 'w');
    try { await file.truncate(bytes); } finally { await file.close(); }
    return path;
  };
  assert.equal((await server.request('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'upload-regression-123' } })).status, 201);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'zhixu_session', value: server.getCookie().split('=')[1], url: server.base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  let chunks = 0, progressSeen = false;
  const acknowledgements = [];
  page.on('response', response => {
    const request = response.request();
    if (request.method() === 'PUT' && request.url().includes('/api/uploads/')) {
      chunks++;
      acknowledgements.push(response.json().then(body => {
        const offset = Number(new URL(request.url()).searchParams.get('offset'));
        const length = body.offset - offset;
        return response.status() === 200 && length > 0 && length <= 8 * 1024 * 1024;
      }).catch(() => false));
    }
  });
  await page.goto(server.base);
  await page.getByRole('navigation', { name: '主要功能' }).getByRole('button', { name: '我的资料库', exact: true }).click();
  await page.getByRole('button', { name: '上传资料', exact: true }).click();
  const input = page.getByLabel('选择学习资料');
  await input.setInputFiles(await createSparse('too-large.pdf', 250 * 1024 * 1024 + 1));
  await page.getByText(/too-large.pdf.*单份资料不能超过 250 MB/).waitFor();
  assert.equal(await page.locator('.file-row').count(), 0);
  await input.setInputFiles(await createSparse('250MB.pdf', 250 * 1024 * 1024));
  assert.equal(await page.locator('.file-row').count(), 1);
  await page.getByRole('button', { name: '移除 250MB.pdf', exact: true }).click();
  await input.setInputFiles(path);
  await page.getByText('198.3 MB', { exact: true }).waitFor();
  const sent = page.waitForResponse(r => r.url().endsWith('/complete') && r.request().method() === 'POST', { timeout: 180000 });
  await page.getByRole('button', { name: '上传 1 份资料', exact: true }).click();
  await page.getByRole('button', { name: /正在上传 \d+%/ }).waitFor(); progressSeen = true;
  const response = await sent;
  assert.equal(response.status(), 202, await response.text());
  const [source] = await response.json();
  assert.equal(source.size, size); assert.equal(source.status, 'ready'); assert.equal(source.pages, 1);
  const detail = (await server.request(`/api/sources/${source.id}`)).data;
  assert.match(detail.chunks.map(c => c.content).join(''), /Large textbook upload regression/);
  assert.ok(chunks < Math.ceil(size / (1024 * 1024)), 'Fast connection grows chunk size to reduce round trips'); assert.ok(progressSeen);
  assert.ok((await Promise.all(acknowledgements)).every(Boolean));
  const download = await fetch(server.base + `/api/sources/${source.id}/file`, { headers: { cookie: server.getCookie(), Range: 'bytes=0-4' } });
  assert.equal(download.status, 206); assert.equal(await download.text(), '%PDF-');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await mkdir(join(projectRoot, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(projectRoot, 'test-results/large-upload.png'), fullPage: true });
  console.log(`✓ ${size} 字节 PDF：250 MB 边界、分块进度、${chunks} 个请求均 ≤ 8 MB、解析正文与 Range 原文读取`);
} finally {
  await browser?.close();
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
