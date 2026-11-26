import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { testServer } from '../tests/helpers.mjs';

const server = await testServer();
let browser;
try {
  await server.request('/api/auth/setup', { method: 'POST', body: { password: 'reader-selection-password' } });
  const concept = (await server.request('/api/knowledge', {
    method: 'POST', body: { title: '区间边界', summary: '边界条件决定查找何时终止。' },
  })).data;
  async function upload(filename, content) {
    const form = new FormData();
    form.append('files', new Blob([content]), filename);
    const { status, data } = await server.request('/api/sources/upload', { method: 'POST', raw: form });
    assert.equal(status, 202);
    return server.ready(data[0].id);
  }
  const needle = '边界条件';
  const doc = await upload('查找.md', '# 闭区间\n先考虑边界条件，再检查边界条件是否包含最后一个元素。');
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('First page ends here.');
  pdf.addPage().drawText('Second page starts here.');
  const twoPages = await upload('two-pages.pdf', await pdf.save());

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.addCookies([{ name: 'zhixu_session', value: server.getCookie().split('=')[1], url: server.base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const button = (scope, name) => scope.getByRole('button', { name, exact: true });
  const toolbar = page.getByRole('toolbar', { name: '选中文本操作' });
  const side = page.locator('.reader-side');
  const detail = async id => (await server.request('/api/sources/' + id)).data;

  // Text positions come from the document body, as in a keyboard selection.
  async function select(start, end, lastOccurrence = false) {
    await page.locator('.reading-paper .rich-text').first().waitFor();
    await page.evaluate(({ start, end, lastOccurrence }) => {
      const texts = [];
      for (const body of document.querySelectorAll('.reading-paper .rich-text')) {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) texts.push(walker.currentNode);
      }
      function endpoint(value) {
        const node = texts.find(t => t.data.includes(value));
        if (!node) throw Error('正文中缺少测试文字 ' + value);
        return { node, offset: lastOccurrence ? node.data.lastIndexOf(value) : node.data.indexOf(value) };
      }
      const a = endpoint(start), b = endpoint(end);
      const range = new Range();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset + end.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      b.node.parentElement.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      b.node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, { start, end, lastOccurrence });
    await toolbar.waitFor();
  }

  await page.goto(server.base + '/#/library/' + doc.id);
  await select(needle, needle, true);
  await button(toolbar, '记笔记').click();
  await page.getByLabel('笔记标题').fill('第二处边界条件');
  await page.getByLabel('笔记内容').fill('核查是否还剩一个元素。');
  await button(page, '保存笔记').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const anchor = (await detail(doc.id)).notes[0].selection;
  assert.equal(anchor.quote, needle);
  assert.equal(anchor.start_offset, doc.chunks[0].content.lastIndexOf(needle));
  assert.equal(anchor.end_offset, anchor.start_offset + needle.length);

  await page.reload();
  await side.getByRole('button', { name: /学习笔记/ }).click();
  await button(side, '查看原文选区').click();
  await page.waitForFunction(({ needle, offset }) => {
    const native = window.getSelection();
    const ranges = native.rangeCount ? [native.getRangeAt(0)] : [];
    for (const highlighted of CSS.highlights?.values() || []) ranges.push(...highlighted);
    return ranges.some(r => r.toString() === needle && r.startOffset === offset);
  }, { needle, offset: anchor.start_offset });

  await page.goto(server.base + '/#/library/' + twoPages.id);
  await page.locator('.reading-paper').getByText('Second page starts here.').waitFor();
  await select('ends here.', 'Second page');
  await button(toolbar, '关联知识点').click();
  const dialog = page.getByRole('dialog', { name: '关联知识点' });
  await dialog.getByLabel('选择知识点').selectOption(concept.id);
  await button(dialog, '保存关联').click();
  await dialog.waitFor({ state: 'hidden' });
  const [link] = (await detail(twoPages.id)).knowledge_links;
  assert.equal(link.knowledge_id, concept.id);
  assert.equal(link.selection.chunk_id, twoPages.chunks[0].id);
  assert.equal(link.selection.end_chunk_id, twoPages.chunks[1].id);
  assert.match(link.selection.quote, /^ends here\.\s*Second page$/);

  await page.goto(server.base + '/#/knowledge?focus=' + concept.id);
  await page.getByRole('button', { name: /two-pages.*查看原文选区/ }).click();
  await page.waitForFunction(() => [...(CSS.highlights.get('reader-quote') || [])]
    .map(r => r.toString()).join('\n') === 'ends here.\nSecond page');
  await button(side, '解除关联').click();
  await button(page.getByRole('dialog', { name: '解除这条原文关联？' }), '解除关联').click();
  await button(side, '解除关联').waitFor({ state: 'hidden' });
  assert.equal((await detail(twoPages.id)).knowledge_links.length, 0);
  assert.deepEqual(errors, []);
  console.log('✓ Markdown 重复原句的第二处划选、笔记刷新定位、PDF 跨页知识关联和解除');
} finally {
  await browser?.close();
  await server.close();
}
