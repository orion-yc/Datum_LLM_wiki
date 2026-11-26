import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { testServer, projectRoot } from '../tests/helpers.mjs';
import { academicPdf } from '../tests/pdf-fixture.mjs';

const server = await testServer(), browser = await chromium.launch({ headless: true });
const out = join(projectRoot, 'test-results'); await mkdir(out, { recursive: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1060 }, locale: 'zh-CN' });
const page = await context.newPage(), errors = [], calls = [], gates = [];
page.on('pageerror', error => errors.push(error.message));
let mode = 'normal', gate;
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw); calls.push(body);
  const currentMode = mode, currentGate = gate;
  if (currentMode === 'blocked') await currentGate.promise;
  res.setHeader('Content-Type', 'application/json');
  if (currentMode === 'failure') { res.writeHead(503); res.end('{}'); return; }
  const number = Number(body.messages[0].content[0].text.match(/PDF page (\d+)/)[1]);
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
    markdown: `# Page ${number}\n\nLeft column evidence, followed by the right column.\n\n| Metric | Value |\n| --- | --- |\n| Latency | 12.5 ms |\n\n$E = mc^2$`,
    blank: false, warnings: ['Verify equation symbols against the original PDF.'],
  }) } }] }));
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const visible = locator => locator.waitFor({ state: 'visible', timeout: 15000 });
const nav = name => page.getByRole('navigation', { name: '主要功能' }).getByRole('button', { name, exact: true }).click();
const dialog = () => page.getByRole('dialog', { name: 'AI 版面解析', exact: true });
const block = () => { mode = 'blocked'; gate = Promise.withResolvers(); gates.push(gate); };
async function until(check, description) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await delay(75); }
  throw new Error(description);
}
const job = async id => (await server.request(`/api/sources/${id}/ai-parse`)).data;
const waitJob = (id, status) => until(async () => (await job(id)).status === status, `Job did not become ${status}: ${server.logs()}`);
try {
  await page.goto(server.base);
  await page.getByLabel('显示姓名', { exact: true }).fill('PDF 研究者');
  await page.getByLabel('空间名称', { exact: true }).fill('论文版面实验室');
  await page.getByLabel('设置访问密码', { exact: true }).fill('pdf-browser-password');
  await page.getByLabel('确认访问密码', { exact: true }).fill('pdf-browser-password');
  await page.getByRole('button', { name: '创建我的知识空间', exact: true }).click();
  await nav('我的资料库'); await page.getByRole('button', { name: '上传资料', exact: true }).click();
  await page.getByLabel('选择学习资料', { exact: true }).setInputFiles({ name: '多栏论文.pdf', mimeType: 'application/pdf', buffer: await academicPdf() });
  const aiToggle = page.getByRole('checkbox', { name: '启用 AI 版面解析（可选）', exact: true });
  assert.equal(await aiToggle.isChecked(), false);
  await aiToggle.check(); await visible(page.getByText('请先由管理员在空间设置中连接支持图片输入的模型。', { exact: true }));
  assert.equal(await page.getByRole('button', { name: '上传 1 份资料', exact: true }).isDisabled(), true);
  await aiToggle.uncheck(); await page.getByRole('button', { name: '上传 1 份资料', exact: true }).click();
  await visible(page.getByRole('heading', { name: '多栏论文', exact: true })); assert.equal(calls.length, 0);
  await server.request('/api/auth/login', { method: 'POST', body: { password: 'pdf-browser-password' } });
  const id = (await server.request('/api/sources')).data[0].id;
  const original = (await server.request(`/api/sources/${id}`)).data;
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${mock.address().port}/v1`);
  await page.getByLabel('模型名称', { exact: true }).fill('chat-model');
  await page.getByLabel('PDF 视觉解析模型（可选）', { exact: true }).fill('vision-pdf-model');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await visible(page.getByText('模型配置已保存。', { exact: true })); await page.reload();
  await until(async () => await page.getByLabel('PDF 视觉解析模型（可选）', { exact: true }).inputValue() === 'vision-pdf-model', 'PDF model was not persisted');
  console.log('✓ PDF 普通上传默认关闭 AI、未配置阻断、网页保存独立视觉模型');

  await page.goto(`${server.base}/#/library/${id}`);
  await page.getByRole('button', { name: 'AI 版面解析', exact: true }).click();
  await dialog().getByLabel('解析范围', { exact: true }).selectOption('range');
  await page.getByLabel('起始页', { exact: true }).fill('1'); await page.getByLabel('结束页', { exact: true }).fill('2');
  block(); await dialog().getByRole('button', { name: '开始增量解析', exact: true }).click();
  await until(() => calls.length > 0, 'No vision request received');
  assert.equal(calls[0].model, 'vision-pdf-model');
  const image = calls[0].messages[0].content.find(part => part.type === 'image_url');
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,\/9j/);
  await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '查看 AI 解析', exact: true }).click(); await visible(dialog().getByRole('button', { name: '取消解析', exact: true }));
  mode = 'normal'; gate.resolve(); await waitJob(id, 'ready');
  await visible(dialog().getByRole('button', { name: '核查并采用本页', exact: true }));
  assert.deepEqual((await server.request(`/api/sources/${id}`)).data.chunks, original.chunks, 'Draft must not change current reading');
  await visible(dialog().getByText('本页需要留意：Verify equation symbols against the original PDF.', { exact: true }));
  await dialog().getByLabel('查看解析页', { exact: true }).selectOption('2');
  const originalLink = dialog().getByRole('link', { name: '查看第 2 页整页原图', exact: true });
  assert.match(await originalLink.getAttribute('href'), /\/pages\/2$/);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => /\/pages\/[12]$/.test(entry.name))), false);
  const [originalTab] = await Promise.all([page.context().waitForEvent('page'), originalLink.click()]);
  await originalTab.locator('img').evaluate(img => img.decode());
  await originalTab.close();
  await visible(dialog().getByRole('table')); await page.screenshot({ path: join(out, 'pdf-ai-review-desktop.png') });
  console.log('✓ 多栏 PDF 逐页图像请求、后台关闭重开、页码切换、原文与表格对照');

  const invitation = (await server.request('/api/team/invitations', { method: 'POST', body: { role: 'viewer' } })).data;
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const mobile = await mobileContext.newPage(); mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(`${server.base}/#/join?token=${invitation.token}`);
  await mobile.getByLabel('成员账号', { exact: true }).fill('pdfviewer'); await mobile.getByLabel('显示姓名', { exact: true }).fill('PDF 只读成员');
  await mobile.getByLabel('设置访问密码', { exact: true }).fill('pdf-viewer-password'); await mobile.getByLabel('确认访问密码', { exact: true }).fill('pdf-viewer-password');
  await mobile.getByRole('button', { name: '创建账号并加入团队', exact: true }).click(); await visible(mobile.getByRole('heading', { name: '成员与权限', exact: true }));
  await mobile.goto(`${server.base}/#/library/${id}`); await mobile.getByRole('button', { name: '查看 AI 解析', exact: true }).click();
  const mobileDialog = mobile.getByRole('dialog', { name: 'AI 版面解析', exact: true });
  await visible(mobileDialog.getByRole('table'));
  assert.equal(await mobileDialog.getByRole('button', { name: '核查并采用本页', exact: true }).count(), 0);
  assert.equal(await mobileDialog.getByRole('button', { name: '放弃本次结果', exact: true }).count(), 0);
  assert.equal(await mobileDialog.getByRole('checkbox', { name: '编辑校对正文', exact: true }).count(), 0);
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.ok(await mobileDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await mobile.screenshot({ path: join(out, 'pdf-ai-review-mobile.png') });
  await mobileDialog.getByRole('button', { name: '关闭', exact: true }).click(); await mobileContext.close();

  await dialog().getByRole('checkbox', { name: '编辑校对正文', exact: true }).check();
  await dialog().getByLabel('第 2 页解析正文', { exact: true }).fill('# Corrected page\n\nCORRECTEDPDFMARKER Confirmed equation and column order.');
  await dialog().getByRole('button', { name: '标记范围已核查', exact: true }).click();
  await dialog().getByRole('button', { name: /^采用全部已核查页/ }).click();
  await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  await visible(page.getByText('CORRECTEDPDFMARKER Confirmed equation and column order.', { exact: true }));
  assert.equal((await job(id)).status, 'applied');
  const adopted = (await server.request(`/api/sources/${id}`)).data;
  assert.equal(adopted.ai_pages, 2);
  assert.ok((await server.request('/api/search?q=CORRECTEDPDFMARKER')).data.chunks.some(chunk => chunk.source_id === id));
  console.log('✓ 手机对照无溢出、只读权限、编辑校对后采用并参与搜索');

  await page.getByRole('button', { name: 'AI 版面解析', exact: true }).click(); mode = 'failure';
  await dialog().getByRole('checkbox', { name: '重新解析所选页（不复用，会再次调用模型）', exact: true }).check();
  await dialog().getByRole('button', { name: '重新解析所选范围', exact: true }).click(); await waitJob(id, 'failed');
  await visible(dialog().getByRole('button', { name: '继续未完成页面', exact: true }));
  assert.deepEqual((await server.request(`/api/sources/${id}`)).data.chunks, adopted.chunks);
  block(); const before = calls.length; await dialog().getByRole('button', { name: '继续未完成页面', exact: true }).click();
  await until(() => calls.length > before, 'Retry did not request model');
  await dialog().getByRole('button', { name: '取消解析', exact: true }).click(); await waitJob(id, 'cancelled');
  mode = 'normal'; gate.resolve(); await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  await nav('我的资料库'); await page.getByRole('button', { name: '上传资料', exact: true }).click();
  await page.getByLabel('选择学习资料', { exact: true }).setInputFiles({ name: '扫描论文.pdf', mimeType: 'application/pdf', buffer: await academicPdf({ pages: 1, scanned: true }) });
  await page.getByRole('checkbox', { name: '启用 AI 版面解析（可选）', exact: true }).check();
  await page.getByLabel('AI 解析前多少页', { exact: true }).fill('1'); await page.getByRole('button', { name: '上传 1 份资料', exact: true }).click();
  await visible(page.getByRole('heading', { name: '扫描论文', exact: true }));
  const scan = (await server.request('/api/sources')).data.find(source => source.title === '扫描论文');
  await waitJob(scan.id, 'ready'); await page.goto(`${server.base}/#/library/${scan.id}`);
  await page.getByRole('button', { name: '查看 AI 解析', exact: true }).click();
  await visible(dialog().getByRole('button', { name: '核查并采用本页', exact: true }));
  await dialog().getByRole('button', { name: '标记范围已核查', exact: true }).click();
  await dialog().getByRole('button', { name: /^采用全部已核查页/ }).click();
  await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  await visible(page.getByText('Left column evidence, followed by the right column.', { exact: true }));
  assert.equal((await server.request(`/api/sources/${scan.id}`)).data.status, 'ready');
  console.log('✓ 模型失败保护、网页重试与取消、上传时启用 AI 处理图片型扫描 PDF');
  await page.goto(`${server.base}/#/library/${id}`);
  await page.getByRole('button', { name: 'AI 版面解析', exact: true }).click();
  await dialog().getByLabel('解析范围', { exact: true }).selectOption('all');
  block();
  await dialog().getByRole('checkbox', { name: '重新解析所选页（不复用，会再次调用模型）', exact: true }).check();
  await dialog().getByRole('button', { name: '重新解析所选范围', exact: true }).click();
  await until(async () => (await job(id)).status === 'running', 'Whole document did not start');
  await dialog().getByRole('button', { name: '暂停解析', exact: true }).click();
  await until(async () => (await job(id)).status === 'paused', 'Whole document did not pause');
  mode = 'normal'; gate.resolve();
  await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  await server.restart(); await page.reload();
  await page.getByRole('button', { name: '查看 AI 解析', exact: true }).click();
  await visible(dialog().getByRole('button', { name: '继续未完成页面', exact: true }));
  await dialog().getByRole('button', { name: '继续未完成页面', exact: true }).click();
  await waitJob(id, 'ready');
  const completedLong = await job(id);
  assert.equal(completedLong.first_page, 1); assert.equal(completedLong.last_page, 2);
  await visible(dialog().getByRole('button', { name: '核查并采用本页', exact: true }));
  await dialog().getByRole('button', { name: '标记范围已核查', exact: true }).click();
  await dialog().getByRole('button', { name: /^采用全部已核查页/ }).click();
  await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  console.log('✓ 整份 PDF 一次排队、暂停跨重启保留、继续未完成页与分批采用');
  assert.deepEqual(errors, []); console.log('PDF AI 浏览器验收全部通过。');
} catch (error) {
  console.error('PDF browser failure:', await page.locator('[role="alert"]').allTextContents(), server.logs());
  await page.screenshot({ path: join(out, 'pdf-ai-failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally {
  for (const gate of gates) gate.resolve();
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  await browser.close(); await server.close();
}
