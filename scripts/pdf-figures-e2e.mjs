import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { testServer } from '../tests/helpers.mjs';
import { illustratedPdf } from '../tests/pdf-fixture.mjs';

const server = await testServer();
let browser;
try {
  await server.request('/api/auth/setup', { method: 'POST', body: { password: 'figure-browser-password' } });
  const form = new FormData(); form.append('files', new Blob([await illustratedPdf()]), '图像教材.pdf');
  const upload = await server.request('/api/sources/upload', { method: 'POST', raw: form });
  const source = await server.ready(upload.data[0].id);
  const wiki = (await server.request('/api/wiki', { method: 'POST', body: { title: '有图的知识页', kind: 'concept',
    body: '查看原文插图。[1]', citations: [{ chunk_id: source.chunks[0].id, source_id: source.id }], related_ids: [] } })).data;
  assert.ok(wiki.id);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addCookies([{ name: 'zhixu_session', value: server.getCookie().split('=')[1], url: server.base }]);
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', r => { if (/\/pdf-figures\/|\/file$/.test(r.url())) requests.push(r.url()); });
  const figure = n => page.locator('img[src*="/pdf-figures/' + n + '/"]:not([src$="/original"])').first();
  async function assertColor(img, color) {
    await img.scrollIntoViewIfNeeded();
    const count = await img.evaluate(async (el, channel) => {
      await el.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 50;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(el, 0, 0, 50, 50);
      const pixels = ctx.getImageData(0, 0, 50, 50).data;
      let matches = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const [r,g,b] = pixels.subarray(i, i + 3);
        if (channel === 'red' ? r > g + 80 && r > b + 80 : b > r + 80 && b > g + 80) matches++;
      }
      return matches;
    }, color);
    assert.ok(count > 40, 'Expected colored PDF content in returned JPEG, got ' + count);
  }

  await page.goto(server.base + '/#/wiki/' + wiki.id);
  const evidence = page.locator('#wiki-evidence-1');
  await evidence.waitFor(); await evidence.scrollIntoViewIfNeeded();
  assert.equal(requests.length, 0);
  await evidence.locator('summary').click();
  await assertColor(figure(1), 'red');
  await page.goto(server.base + '/#/library/' + source.id);
  for (const [n, color] of [[1, 'red'], [2, 'blue']]) {
    const section = page.locator('.reading-paper').getByRole('heading', { name: '第 ' + n + ' 页', exact: true });
    await section.scrollIntoViewIfNeeded();
    await assertColor(figure(n), color);
  }
  const scan = page.getByRole('link', { name: '查看第 3 页整页原图', exact: true });
  await scan.scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole('link', { name: '打开完整 PDF' }).getAttribute('href'), `/api/sources/${source.id}/file#page=1`);
  assert.equal(requests.some(url => /\/original$|\/pdf-figures\/3\/\d+$|\/file$/.test(url)), false);
  const [original] = await Promise.all([ctx.waitForEvent('page'), scan.click()]);
  await assertColor(original.locator('img'), 'red');
  await original.close();
  console.log('✓ 正文与 Wiki 引用保留局部插图，整页扫描图仅在点击链接后加载');
} finally {
  await browser?.close();
  await server.close();
}
