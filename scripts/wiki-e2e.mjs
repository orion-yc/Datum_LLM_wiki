import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { testServer, projectRoot } from '../tests/helpers.mjs';

const server = await testServer(), browser = await chromium.launch({ headless: true });
const out = join(projectRoot, 'test-results'); await mkdir(out, { recursive: true });
const errors = [], context = await browser.newContext({ viewport: { width: 1440, height: 1060 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' }), page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
const visible = locator => locator.waitFor({ state: 'visible', timeout: 15000 });
const nav = name => page.getByRole('navigation', { name: '主要功能' }).getByRole('button', { name, exact: true }).click();
const dialog = name => page.getByRole('dialog', { name, exact: true });
try {
  await page.goto(server.base); await page.getByLabel('显示姓名', { exact: true }).fill('Wiki 整理者'); await page.getByLabel('空间名称', { exact: true }).fill('知识生长实验室'); await page.getByLabel('设置访问密码', { exact: true }).fill('wiki-browser-password'); await page.getByLabel('确认访问密码', { exact: true }).fill('wiki-browser-password'); await page.getByRole('button', { name: '创建我的知识空间', exact: true }).click();
  await nav('我的资料库'); await page.getByRole('button', { name: '上传资料', exact: true }).click();
  await page.getByLabel('选择学习资料', { exact: true }).setInputFiles([
    { name: '查找教材.md', mimeType: 'text/markdown', buffer: Buffer.from('# 算法前提\n二分查找需要有序序列，候选区间每轮缩小。\n## 边界规则\n闭区间在左右边界相等时仍然存在一个候选值。') },
    { name: '边界实验.md', mimeType: 'text/markdown', buffer: Buffer.from('# 测试设计\n边界验证应覆盖空数组、单个元素和目标不存在。\n## 复杂度\n有序查找需要对数次比较，应同时记录数据规模和排序成本。') },
  ]);
  await page.getByRole('button', { name: '上传 2 份资料', exact: true }).click(); await visible(page.getByRole('heading', { name: '查找教材', exact: true }));
  await server.request('/api/auth/login', { method: 'POST', body: { password: 'wiki-browser-password' } });
  await nav('知识 Wiki'); await page.getByRole('button', { name: '从资料整理', exact: true }).click();
  await page.getByLabel('整理主题', { exact: true }).fill('查找边界实践 boundarybridgealias'); await page.getByLabel('希望解决的问题', { exact: true }).fill('比较教材规则和实验验证的关系。');
  await page.getByRole('checkbox', { name: /查找教材/ }).check(); await page.getByRole('checkbox', { name: /边界实验/ }).check(); await page.getByRole('button', { name: '生成可编辑草稿', exact: true }).click();
  await visible(dialog('整理 Wiki 知识页草稿')); assert.equal((await server.request('/api/wiki')).data.length, 0);
  assert.equal(await page.getByLabel('知识页标题', { exact: true }).evaluate(input => input === document.activeElement), true, '编辑器出现时立即完成焦点定位');
  await visible(page.getByText('查找教材：使用 2/2 个片段', { exact: true })); await page.getByLabel('知识页摘要', { exact: true }).fill('把算法前提、区间不变量与实验边界整理在一起。'); await page.getByLabel('知识页标签', { exact: true }).fill('算法，边界，实验');
  await page.getByLabel('知识页正文', { exact: true }).fill('## 适用条件\n有序序列是二分查找的前提。[1]\n\n## 如何验证\n测试空数组、首尾元素和目标不存在，并核对循环不变量。[3]\n\n```cpp\nwhile (left <= right) { /* 检查区间 */ }\n```');
  await page.getByRole('button', { name: '预览正文', exact: true }).click(); await visible(page.getByRole('button', { name: '继续编辑', exact: true })); await visible(dialog('整理 Wiki 知识页草稿').locator('pre code')); await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await page.getByRole('button', { name: '保存知识页草稿', exact: true }).click(); await visible(page.getByRole('heading', { name: '查找边界实践 boundarybridgealias', exact: true }));
  const id = (await page.evaluate(() => location.hash)).split('/')[2];
  await page.getByRole('button', { name: '[1]', exact: true }).first().click(); await visible(page.locator('#wiki-evidence-1[open]'));
  await page.getByRole('button', { name: '核对并发布', exact: true }).click(); await page.getByRole('button', { name: '确认发布知识页', exact: true }).click(); await visible(page.getByText('已发布', { exact: true }));
  assert.equal((await server.request(`/api/wiki/${id}`)).data.status, 'published'); await page.screenshot({ path: join(out, 'wiki-published.png'), fullPage: true });
  console.log('✓ 网页上传、跨资料草稿、范围提示、代码预览、真实引用与发布');
  await nav('知识 Wiki'); await page.getByRole('button', { name: '手动建立知识页', exact: true }).click(); await page.getByLabel('知识页标题', { exact: true }).fill('区间不变量备忘'); await page.getByLabel('知识页正文', { exact: true }).fill('循环边界需要和区间定义保持一致。[1]');
  await page.getByRole('button', { name: '添加原文证据', exact: true }).click(); const sources = (await server.request('/api/sources')).data; await page.getByLabel('证据来源资料', { exact: true }).selectOption(sources.find(s => s.title === '查找教材').id); await page.getByLabel('筛选原文片段', { exact: true }).fill('边界');
  await page.locator('.evidence-picker input[type="checkbox"]').first().check(); await page.getByRole('button', { name: '添加选中证据（1/32）', exact: true }).click();
  await page.getByLabel('关联知识页', { exact: true }).selectOption(id); await page.getByRole('button', { name: '保存知识页草稿', exact: true }).click(); await visible(page.getByRole('heading', { name: '区间不变量备忘', exact: true }));
  await page.locator('.wiki-side').getByRole('button', { name: '查找边界实践 boundarybridgealias', exact: true }).click(); await visible(page.locator('.wiki-side').getByRole('button', { name: '区间不变量备忘', exact: true }));
  await page.getByRole('button', { name: '历史版本', exact: true }).click(); await visible(dialog('知识页版本记录')); await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await nav('知识 Wiki'); await page.getByRole('button', { name: /质量检查/ }).click(); await visible(page.getByRole('heading', { name: '知识库质量检查', exact: true })); await visible(page.getByText('草稿待整理与核对，尚未用于辅助问答检索。', { exact: true })); await page.screenshot({ path: join(out, 'wiki-audit.png'), fullPage: true });
  console.log('✓ 网页手动建页、证据选择、关联与反向链接、历史查看和质量检查');
  await nav('和知识对话'); await page.getByLabel('输入学习问题', { exact: true }).fill('boundarybridgealias'); await page.getByRole('button', { name: '发送问题', exact: true }).click(); await visible(page.getByText('经由知识 Wiki 定位原文', { exact: true }));
  await page.locator('.wiki-trace button').first().click(); await visible(page.getByRole('heading', { name: '查找边界实践 boundarybridgealias', exact: true }));
  await page.getByRole('button', { name: '转为草稿', exact: true }).click(); await page.getByRole('button', { name: '确认转为草稿', exact: true }).click(); await visible(page.getByRole('button', { name: '编辑知识页', exact: true }));
  await page.getByRole('button', { name: '编辑知识页', exact: true }).click(); await page.getByLabel('知识页摘要', { exact: true }).fill('新的摘要用于验证恢复。'); await page.getByRole('button', { name: '保存知识页草稿', exact: true }).click(); await visible(page.getByText('新的摘要用于验证恢复。', { exact: true }));
  await page.getByRole('button', { name: '历史版本', exact: true }).click(); await page.getByRole('button', { name: '恢复为新草稿', exact: true }).last().click(); await page.getByRole('button', { name: '恢复知识页版本', exact: true }).click(); await visible(page.getByText('把算法前提、区间不变量与实验边界整理在一起。', { exact: true }));
  await page.getByRole('button', { name: '搜索你的知识…', exact: false }).click(); await page.getByLabel('全局搜索', { exact: true }).fill('boundarybridgealias'); await visible(page.getByRole('heading', { name: 'Wiki 知识页', exact: true })); await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  console.log('✓ 网页 Wiki 检索线索、管理员重开、版本恢复和全局搜索');
  const invite = (await server.request('/api/team/invitations', { method: 'POST', body: { role: 'viewer' } })).data;
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' }), mobile = await mobileContext.newPage(); mobile.on('pageerror', e => errors.push(e.message));
  await mobile.goto(`${server.base}/#/join?token=${invite.token}`); await mobile.getByLabel('成员账号', { exact: true }).fill('wikiviewer'); await mobile.getByLabel('显示姓名', { exact: true }).fill('Wiki 只读者'); await mobile.getByLabel('设置访问密码', { exact: true }).fill('viewer-browser-password'); await mobile.getByLabel('确认访问密码', { exact: true }).fill('viewer-browser-password'); await mobile.getByRole('button', { name: '创建账号并加入团队', exact: true }).click(); await visible(mobile.getByRole('heading', { name: '成员与权限', exact: true }));
  await mobile.goto(`${server.base}/#/wiki/${id}`); await visible(mobile.getByRole('heading', { name: '查找边界实践 boundarybridgealias', exact: true })); assert.equal(await mobile.getByRole('button', { name: '编辑知识页', exact: true }).count(), 0); assert.equal(await mobile.getByRole('button', { name: '核对并发布', exact: true }).count(), 0); assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await mobile.getByRole('button', { name: '历史版本', exact: true }).click(); await visible(mobile.getByRole('dialog', { name: '知识页版本记录', exact: true })); await mobile.getByRole('button', { name: '关闭窗口', exact: true }).click(); await mobile.screenshot({ path: join(out, 'wiki-mobile-readonly.png'), fullPage: true });
  console.log('✓ Wiki 手机阅读、代码与证据布局、只读权限和历史窗口关闭');
  assert.deepEqual(errors, []); console.log('Wiki 浏览器验收全部通过。');
} catch (error) {
  console.error('Wiki 验收失败时的编辑器状态：', await page.evaluate(() => ({
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map(dialog => ({
      text: dialog.textContent, body: dialog.querySelector('textarea[rows="13"]')?.value,
      preview: dialog.querySelector('.wiki-preview')?.textContent,
      codeBlocks: dialog.querySelectorAll('pre code').length
    })), alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent)
  })).catch(() => null));
  await page.screenshot({ path: join(out, 'wiki-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await browser.close(); await server.close(); }
