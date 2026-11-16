import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { testServer, projectRoot } from '../tests/helpers.mjs';

const server = await testServer();
const browser = await chromium.launch({ headless: true });
const out = join(projectRoot, 'test-results'); await mkdir(out, { recursive: true });
const errors = [], pages = [], failedRequests = [];
async function pageFor(width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 1080 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage(); pages.push(page);
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', async response => {
    if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/'))
      failedRequests.push({ path: new URL(response.url()).pathname, status: response.status(), body: await response.text().catch(() => '') });
  });
  return page;
}
const page = await pageFor();
const nav = async (page, name) => page.getByRole('navigation', { name: '主要功能' }).getByRole('button', { name, exact: true }).click();
const visible = async locator => locator.waitFor({ state: 'visible', timeout: 15000 });
try {
  await page.goto(server.base); await page.getByLabel('显示姓名', { exact: true }).fill('团队所有者'); await page.getByLabel('空间名称', { exact: true }).fill('证据研究小组'); await page.getByLabel('设置访问密码', { exact: true }).fill('owner-browser-password'); await page.getByLabel('确认访问密码', { exact: true }).fill('owner-browser-password'); await page.getByRole('button', { name: '创建我的知识空间', exact: true }).click();
  await nav(page, '团队协作'); await visible(page.getByRole('heading', { name: '成员与权限', exact: true }));
  await page.getByRole('button', { name: '生成邀请链接', exact: true }).click(); const invitation = page.getByLabel('一次性邀请链接', { exact: true }); await visible(invitation); const invitationUrl = await invitation.inputValue();
  const reviewer = await pageFor(); await reviewer.goto(invitationUrl); await reviewer.getByLabel('成员账号', { exact: true }).fill('reviewer'); await reviewer.getByLabel('显示姓名', { exact: true }).fill('论文审核人'); await reviewer.getByLabel('设置访问密码', { exact: true }).fill('reviewer-browser-password'); await reviewer.getByLabel('确认访问密码', { exact: true }).fill('reviewer-browser-password'); await reviewer.getByRole('button', { name: '创建账号并加入团队', exact: true }).click(); await visible(reviewer.getByRole('heading', { name: '成员与权限', exact: true }));
  console.log('✓ 网页初始化团队、一次性邀请与独立账号加入');
  await server.request('/api/auth/login', { method: 'POST', body: { password: 'owner-browser-password' } });
  const sources = [];
  for (const [title, content] of [['论文甲', '# 方法\n采用有序索引，查询需要维护排序。\n## 指标\n实验集合 A 延迟 10 ms。'], ['论文乙', '# 方法\n采用哈希映射，需要额外存储空间。\n## 指标\n实验集合 B 延迟 12 ms，不能直接比较。']]) { const form = new FormData(); form.append('files', new Blob([content]), `${title}.md`); const r = await server.request('/api/sources/upload', { method: 'POST', raw: form }); assert.equal(r.status, 202); sources.push(r.data[0]); }
  await nav(page, '论文研究');
  for (const source of sources) { await page.getByRole('button', { name: '建立论文档案', exact: true }).click(); await page.getByLabel('论文原文资料', { exact: true }).selectOption(source.id); await page.getByLabel('论文标题', { exact: true }).fill(source.title); await page.getByLabel('作者', { exact: true }).fill('研究者'); await page.getByLabel('发表年份', { exact: true }).fill('2026'); await page.getByRole('button', { name: '保存论文档案', exact: true }).click(); await visible(page.getByRole('button', { name: source.title, exact: true })); }
  await page.getByRole('button', { name: '新建论文对比', exact: true }).click(); await page.getByLabel('对比名称', { exact: true }).fill('查找方法证据对比'); await page.getByLabel('研究问题', { exact: true }).fill('不同实验设置下，方法有哪些适用边界？'); await page.getByRole('checkbox', { name: /论文甲/ }).check(); await page.getByRole('checkbox', { name: /论文乙/ }).check(); await page.getByLabel('对比维度', { exact: true }).fill('核心方法，评价指标'); await page.getByRole('button', { name: '创建对比矩阵', exact: true }).click(); await visible(page.getByRole('heading', { name: '查找方法证据对比', exact: true }));
  const comparisonId = (await page.evaluate(() => location.hash)).split('/')[2];
  await page.getByLabel('审核人', { exact: true }).selectOption({ label: '论文审核人' });
  for (const title of ['论文甲', '论文乙']) for (const dim of ['核心方法', '评价指标']) await page.getByLabel(`${title} ${dim}`, { exact: true }).fill(`${title}的${dim}需要结合原文实验设置理解。`);
  for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: '关联证据（0）', exact: true }).first().click(); await visible(page.getByRole('heading', { name: '关联原文证据', exact: true })); await page.locator('.evidence-picker input[type="checkbox"]').first().check(); await page.getByRole('button', { name: '保存证据关联', exact: true }).click(); }
  await page.getByLabel('对比结论', { exact: true }).fill('两篇论文的实验集合不同，延迟数值不宜直接排名，需要统一实验设置验证。'); await page.getByRole('button', { name: '保存对比', exact: true }).first().click(); await visible(page.getByText('版本 2', { exact: false }));
  await page.getByRole('button', { name: '提交审核', exact: true }).click(); await visible(page.getByText('审核中', { exact: true }));
  await reviewer.goto(`${server.base}/#/papers/${comparisonId}`); await visible(reviewer.getByRole('button', { name: '审核通过并发布', exact: true }));
  await reviewer.getByLabel('协作评论', { exact: true }).fill('已核对证据，实验设置差异需要明确保留。'); await reviewer.getByRole('button', { name: '发表评论', exact: true }).click(); await visible(reviewer.getByText('已核对证据，实验设置差异需要明确保留。', { exact: true }));
  const blockedPublication = reviewer.waitForResponse(response => response.url() === `${server.base}/api/comparisons/${comparisonId}/status` && response.request().method() === 'POST');
  await reviewer.getByRole('button', { name: '审核通过并发布', exact: true }).click();
  const blockedResponse = await blockedPublication;
  assert.equal(blockedResponse.status(), 409, await blockedResponse.text());
  assert.equal((await blockedResponse.json()).error, '还有未解决的审核评论，请处理后再发布。');
  await visible(reviewer.getByText('还有未解决的审核评论，请处理后再发布。', { exact: true }));
  await reviewer.getByRole('button', { name: '标记已解决', exact: true }).click(); await visible(reviewer.getByRole('button', { name: '重新打开', exact: true })); await reviewer.getByRole('button', { name: '审核通过并发布', exact: true }).click(); await visible(reviewer.getByText('已发布', { exact: true }));
  assert.equal((await server.request(`/api/comparisons/${comparisonId}`)).data.status, 'published');
  await reviewer.screenshot({ path: join(out, 'research-published.png'), fullPage: true });
  console.log('✓ 网页论文档案、矩阵编辑、真实证据、跨账号审核、评论阻断与发布');
  await reviewer.clock.install(); await reviewer.reload();
  await visible(reviewer.getByRole('button', { name: '分配任务', exact: true }));
  await reviewer.getByRole('button', { name: '分配任务', exact: true }).click(); await reviewer.getByLabel('任务名称', { exact: true }).fill('补充统一设置实验'); await reviewer.getByLabel('任务说明', { exact: true }).fill('在相同数据集下验证两种方法。'); await reviewer.getByLabel('负责人', { exact: true }).selectOption({ label: '论文审核人 · 编辑者' }); await reviewer.getByRole('button', { name: '创建任务', exact: true }).click(); await nav(reviewer, '团队协作'); await visible(reviewer.getByRole('heading', { name: '成员与权限', exact: true })); await visible(reviewer.getByRole('button', { name: '补充统一设置实验', exact: true }));
  // Hold list refreshes and PATCH responses independently to expose stale-version windows.
  const listGate = Promise.withResolvers(), listArrived = Promise.withResolvers(), writes = [];
  let pendingWrite;
  const listRoute = async route => {
    const response = await route.fetch(); listArrived.resolve();
    await listGate.promise; await route.fulfill({ response });
  };
  const writeRoute = async route => {
    writes.push(route.request().postDataJSON());
    const pending = pendingWrite;
    const response = pending.fail ? null : await route.fetch();
    pending.arrived.resolve(response);
    await pending.release.promise;
    if (pending.fail) await route.fulfill({ status: 503, json: { error: '测试：任务保存暂时不可用。' } });
    else await route.fulfill({ response });
  };
  await reviewer.route('**/api/tasks', listRoute);
  await reviewer.route('**/api/tasks/*', writeRoute);
  const taskSelect = reviewer.getByLabel('补充统一设置实验任务状态', { exact: true });
  const taskInColumn = status => reviewer.locator('.task-columns section').nth(['todo', 'doing', 'done'].indexOf(status)).getByRole('button', { name: '补充统一设置实验', exact: true });
  async function moveTask(status, version, fail = false) {
    pendingWrite = { arrived: Promise.withResolvers(), release: Promise.withResolvers(), fail };
    await taskSelect.selectOption(status);
    const response = await pendingWrite.arrived.promise;
    try {
      assert.equal(await taskSelect.isDisabled(), true, '保存响应返回前不允许重复提交');
      if (response) assert.equal(response.status(), 200, await response.text());
    } finally { pendingWrite.release.resolve(); }
    if (fail) {
      await visible(reviewer.getByRole('alert').filter({ hasText: '测试：任务保存暂时不可用。' }));
      await visible(taskInColumn('doing'));
    } else {
      await visible(taskInColumn(status));
      assert.equal(await taskSelect.inputValue(), status);
      const persisted = (await server.request('/api/tasks')).data.find(task => task.title === '补充统一设置实验');
      assert.equal(persisted.status, status); assert.equal(persisted._version, version);
    }
  }
  try {
    await reviewer.clock.fastForward(10000); await listArrived.promise;
    await moveTask('doing', 2);
    await visible(reviewer.locator('.task-card .task-meta').getByText('论文审核人', { exact: true }));
    await moveTask('done', 2, true);
    await moveTask('done', 3);
    assert.deepEqual(writes.map(({ status, _version }) => ({ status, _version })), [
      { status: 'doing', _version: 1 }, { status: 'done', _version: 2 }, { status: 'done', _version: 2 }
    ]);
    const staleList = reviewer.waitForResponse(response => response.url() === `${server.base}/api/tasks`);
    listGate.resolve(); await (await staleList).finished();
    await reviewer.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await visible(taskInColumn('done'));
    assert.equal(await taskSelect.inputValue(), 'done', '迟到的旧列表不能撤回已保存的状态');
  } finally {
    pendingWrite?.release.resolve(); listGate.resolve();
    await reviewer.unroute('**/api/tasks', listRoute); await reviewer.unroute('**/api/tasks/*', writeRoute);
  }
  await reviewer.reload(); await visible(taskInColumn('done'));
  await reviewer.screenshot({ path: join(out, 'team-tasks.png'), fullPage: true });
  console.log('✓ 网页任务状态推进：慢响应、版本递增、保存失败重试与刷新持久化');
  await page.getByRole('button', { name: '读取最新版本', exact: true }).click(); await page.getByRole('button', { name: '历史版本', exact: true }).click(); await visible(page.getByRole('heading', { name: '对比版本记录', exact: true })); await page.getByRole('button', { name: '恢复为新草稿', exact: true }).last().click(); await page.getByRole('button', { name: '恢复版本', exact: true }).click(); await visible(page.getByText('草稿', { exact: true }));
  const invite = (await server.request('/api/team/invitations', { method: 'POST', body: { role: 'viewer' } })).data;
  const viewer = await pageFor(390); await viewer.goto(`${server.base}/#/join?token=${invite.token}`); await viewer.getByLabel('成员账号', { exact: true }).fill('viewer'); await viewer.getByLabel('显示姓名', { exact: true }).fill('只读成员'); await viewer.getByLabel('设置访问密码', { exact: true }).fill('viewer-browser-password'); await viewer.getByLabel('确认访问密码', { exact: true }).fill('viewer-browser-password'); await viewer.getByRole('button', { name: '创建账号并加入团队', exact: true }).click(); await visible(viewer.getByRole('heading', { name: '成员与权限', exact: true })); await viewer.goto(`${server.base}/#/papers/${comparisonId}`); await visible(viewer.getByRole('heading', { name: '查找方法证据对比', exact: true })); assert.equal(await viewer.getByRole('button', { name: '保存对比', exact: true }).count(), 0); assert.equal(await viewer.getByRole('button', { name: '发表评论', exact: true }).count(), 0); assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await viewer.screenshot({ path: join(out, 'research-mobile-readonly.png'), fullPage: true });
  await viewer.getByRole('button', { name: '展开导航', exact: true }).click();
  await viewer.getByRole('button', { name: '空间设置', exact: true }).click();
  await visible(viewer.getByLabel('推理强度', { exact: true }));
  assert.equal(await viewer.getByLabel('推理强度', { exact: true }).isDisabled(), true);
  assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await viewer.screenshot({ path: join(out, 'model-reasoning-mobile-readonly.png'), fullPage: true, animations: 'disabled' });
  console.log('✓ 历史恢复、只读成员、移动端矩阵与模型设置权限');
  assert.deepEqual(errors, []); console.log('团队与论文浏览器验收全部通过。');
} catch (error) {
  console.error('团队验收失败时的接口错误：', JSON.stringify(failedRequests));
  await Promise.allSettled(pages.map((page, index) => page.screenshot({ path: join(out, `team-failure-${index}.png`), fullPage: true })));
  throw error;
} finally { await browser.close(); await server.close(); }
