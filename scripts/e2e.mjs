import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { testServer, projectRoot } from '../tests/helpers.mjs';

const server = await testServer();
let browser;
try { browser = await chromium.launch({ headless: true }); } catch (error) { await server.close(); throw error; }
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const out = join(projectRoot, 'test-results'); await mkdir(out, { recursive: true });
const nav = async label => { await page.getByRole('navigation', { name: '主要功能' }).getByRole('button', { name: label, exact: true }).click(); };
const visible = async locator => { await locator.waitFor({ state: 'visible', timeout: 15000 }); };
const waitText = async text => visible(page.getByText(text, { exact: true }).first());

try {
  await page.goto(server.base);
  await page.getByLabel('显示姓名', { exact: true }).fill('浏览器测试用户');
  await page.getByLabel('设置访问密码').fill('browser-test-password');
  await page.getByLabel('确认访问密码').fill('browser-test-password');
  await page.getByRole('button', { name: '创建我的知识空间' }).click();
  await visible(page.getByRole('heading', { name: '每一点积累，都算数。' }));
  console.log('✓ 网页首次初始化与空状态');

  await nav('我的资料库');
  await page.getByRole('button', { name: '体验原创示例' }).click();
  await visible(page.locator('.book-card').first());
  const source = (await server.request('/api/auth/login', { method: 'POST', body: { password: 'browser-test-password' } })).status;
  assert.equal(source, 200);
  const sources = (await server.request('/api/sources')).data;
  await server.ready(sources[0].id);
  await page.locator('.book-card').first().click();
  await visible(page.getByRole('button', { name: '整理知识点', exact: true }));
  await page.getByRole('button', { name: '整理知识点', exact: true }).click();
  await visible(page.locator('.reader-knowledge').first());
  await page.getByRole('button', { name: '添加笔记', exact: true }).count().then(async count => { if (!count) await page.getByRole('button', { name: /学习笔记/ }).click(); });
  await page.getByRole('button', { name: '添加笔记', exact: true }).click();
  await page.getByLabel('笔记标题').fill('闭区间边界的理解');
  await page.getByLabel('笔记内容').fill('left 等于 right 时仍有一个候选元素，因此要继续比较。');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await waitText('闭区间边界的理解');
  await page.getByRole('slider', { name: '阅读进度', exact: true }).fill('35');
  await page.locator('.reader-progress').getByRole('button', { name: '保存', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: /学习笔记/ }).click(); await waitText('闭区间边界的理解');
  await page.screenshot({ path: join(out, 'reader.png'), fullPage: true, animations: 'disabled' });
  console.log('✓ 原创示例、阅读、知识点草稿、笔记、进度与刷新持久化');

  await nav('知识与技能');
  await visible(page.locator('.knowledge-card').first());
  await page.locator('.knowledge-card').first().getByRole('button', { name: /编辑知识点/ }).click();
  await page.getByLabel('保留为待核对草稿').uncheck();
  await page.getByLabel('标签', { exact: true }).fill('算法，边界');
  await page.getByRole('button', { name: '保存知识点', exact: true }).click();
  await visible(page.locator('.knowledge-card').first());
  await page.getByRole('button', { name: /^技能/ }).click();
  await page.getByRole('button', { name: '添加技能', exact: true }).first().click();
  await page.getByLabel('技能名称').fill('独立实现二分查找');
  await page.getByLabel('技能描述').fill('实现查找并说明循环边界。');
  await page.getByLabel('完成标准').fill('通过空数组与首尾用例。');
  await page.getByRole('button', { name: '保存技能', exact: true }).click();
  await waitText('独立实现二分查找');
  console.log('✓ 知识点确认、编辑与技能创建');

  await nav('学习计划');
  await page.getByRole('button', { name: '新建计划', exact: true }).click();
  await page.getByLabel('计划名称').fill('算法基础学习计划');
  await page.getByLabel('学习目标与完成标准').fill('解释并实现二分查找。');
  await page.getByRole('textbox', { name: '第 1 步', exact: true }).fill('理解区间定义');
  await page.getByRole('button', { name: '添加步骤', exact: true }).click();
  await page.getByRole('textbox', { name: '第 2 步', exact: true }).fill('完成边界练习');
  await page.getByRole('button', { name: '保存计划', exact: true }).click();
  await visible(page.getByRole('heading', { name: '算法基础学习计划' }));
  await page.getByRole('button', { name: '理解区间定义', exact: true }).click();
  await waitText('50%');
  console.log('✓ 学习计划创建与步骤完成');

  await nav('和知识对话');
  await page.getByRole('textbox', { name: '输入学习问题' }).fill('二分查找为什么要求有序序列？');
  await page.getByRole('button', { name: '发送问题' }).click();
  await visible(page.locator('.citation-card').first());
  await visible(page.getByText('原文摘录', { exact: true }));
  await page.screenshot({ path: join(out, 'chat.png'), fullPage: true, animations: 'disabled' });
  await page.locator('.citation-card').first().click();
  await visible(page.getByRole('button', { name: '返回学习对话' }));
  await page.getByRole('button', { name: '返回学习对话' }).click();
  await visible(page.locator('.citation-card').first());
  console.log('✓ 网页问答、真实引用、原文定位与对话恢复');

  await nav('练习与复习');
  await page.getByRole('button', { name: '开始新练习', exact: true }).click();
  await page.getByLabel('选择知识点').selectOption({ index: 1 });
  await page.getByRole('button', { name: '创建练习', exact: true }).click();
  await page.getByLabel('你的回答').fill('二分查找需要有序序列，每次排除一半候选区域。');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await visible(page.getByText('本人自评', { exact: true }));
  await page.getByRole('button', { name: /基本理解.*3 天后/ }).click();
  await page.getByRole('button', { name: '已完成', exact: true }).click();
  await visible(page.getByText('已完成自评', { exact: true }));
  console.log('✓ 练习作答、自评、复习与历史记录');

  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await visible(page.getByLabel('API 基础地址'));
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: '导出学习记录' }).click(); const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /zhixu-learning.*\.json/);
  console.log('✓ 网页设置与数据导出');

  await nav('我的资料库');
  await page.getByRole('button', { name: '上传资料', exact: true }).click();
  await page.getByLabel('选择学习资料').setInputFiles({ name: '项目实践笔记.md', mimeType: 'text/markdown', buffer: Buffer.from('# 项目实践笔记\n这是浏览器验收中上传的原创笔记。\n## 记录设计决策\n将背景、选项、选择原因与验证结果写在一起，帮助之后理解项目。') });
  await page.getByLabel('资料用途').selectOption('项目知识');
  await page.getByRole('button', { name: '上传 1 份资料', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await visible(page.locator('.book-card').filter({ hasText: '项目实践笔记' }));
  const uploaded = (await server.request('/api/sources')).data.find(s => s.filename === '项目实践笔记.md');
  assert.equal((await server.ready(uploaded.id)).status, 'ready');
  console.log('✓ 网页文件选择、分类与真实上传');

  await nav('学习首页');
  await visible(page.locator('.book-card').first());
  await page.screenshot({ path: join(out, 'dashboard.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: /搜索你的知识/ }).count().then(async () => { await page.locator('.global-search').click(); });
  await page.getByRole('textbox', { name: '全局搜索' }).fill('二分查找');
  await visible(page.locator('.search-result').first());
  await page.getByRole('button', { name: '关闭窗口' }).click();
  console.log('✓ 首页真实统计、全局搜索');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(out, 'mobile.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, '手机页面不应横向溢出');
  await page.getByRole('button', { name: '展开导航' }).click();
  await nav('我的资料库');
  await visible(page.getByRole('button', { name: '上传资料', exact: true }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  console.log('✓ 手机布局与导航，无横向溢出');
  assert.deepEqual(errors, [], '浏览器不应出现运行时异常');
  console.log(`全部浏览器验收通过。截图：${out}`);
} catch (error) {
  await page.screenshot({ path: join(out, 'failure.png'), fullPage: true });
  console.error('浏览器验收失败:', error);
  console.error('Browser URL:', page.url());
  process.exitCode = 1;
} finally { await browser.close(); await server.close(); }
