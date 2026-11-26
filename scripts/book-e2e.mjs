import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {PDFDocument} from 'pdf-lib';
import {testServer} from '../tests/helpers.mjs';

const app=await testServer();
let answer={summary:'本章导读',body:'整理本章概念和示例。[1]',links:[]};
let releaseTrial;
const trialGate=new Promise(resolve=>{ releaseTrial=resolve; });
const model=createServer(async (req,res)=>{
  for await(const _ of req) {}
  await trialGate;
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}));
});
let browser;
try {
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  await app.request('/api/auth/setup',{method:'POST',body:{password:'book-browser-test'}});
  await app.request('/api/settings',{method:'PUT',body:{baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',model:'book-mock'}});
  const form=new FormData();
  form.append('files',new Blob(['# 第一章 表示\n研究数据表示。\n## 整数\n整数存储例子。\n# 第二章 运算\n说明如何执行整数运算。']),'数据表示.md');
  const upload=await app.request('/api/sources/upload',{method:'POST',raw:form});
  const source=await app.ready(upload.data[0].id);
  browser=await chromium.launch();
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await context.addCookies([{name:'zhixu_session',value:app.getCookie().split('=')[1],url:app.base}]);
  const page=await context.newPage();
  await page.goto(app.base+'/#/wiki?source='+source.id);
  const dialog=page.getByRole('dialog',{name:'全文导读'});
  await dialog.getByLabel('目录标题 1',{exact:true}).fill('第一章 数据表示');
  assert.equal(await dialog.getByLabel('目录层级 2',{exact:true}).inputValue(),'2');
  await dialog.getByRole('button',{name:'确认目录',exact:true}).click();
  const accepted=page.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/book/'+source.id)
    && r.request().postDataJSON()?.action==='start');
  await dialog.getByRole('button',{name:'试生成本章',exact:true}).first().click();
  const submission=await accepted;
  assert.equal(submission.status(),202);
  const task=(await submission.json()).job;
  assert.ok(task.id);
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.goto(app.base+'/#/library');
  await page.goto(app.base+'/#/wiki?source='+source.id);
  await dialog.waitFor();
  assert.equal((await app.request('/api/wiki/book/'+source.id+'?job=latest')).data.job.id,task.id);
  releaseTrial();
  await dialog.getByRole('link',{name:'第一章 数据表示',exact:true}).waitFor();
  assert.equal((await app.request('/api/wiki')).data.length,1);
  await dialog.getByRole('button',{name:'整理全书剩余章节',exact:true}).click();
  await dialog.getByRole('link',{name:'第二章 运算',exact:true}).waitFor();
  assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  const plan=(await app.request('/api/wiki/book/'+source.id)).data;
  assert.equal(plan.entries.length,3);
  assert.ok(plan.entries.every(e=>e.wiki_id));
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.goto(app.base+'/#/wiki?system='+plan.system_id);
  const outline=page.getByRole('region',{name:'数据表示章节目录'});
  await outline.getByText('1 个小节').click();
  await outline.getByRole('link',{name:'整数',exact:true}).click();
  await page.getByRole('heading',{name:'整数',exact:true}).waitFor();
  console.log('✓ 手机书籍目录核对、单章试生成、续做全书和按章阅读');

  const englishPdf=await PDFDocument.create();
  englishPdf.addPage().drawText('Abstract: We study mean absolute error (MAE).', {x:40,y:700,size:14});
  englishPdf.addPage().drawText('Results: Table 1 reports MAE on dataset A only.', {x:40,y:700,size:14});
  const paperForm=new FormData();
  paperForm.append('files',new Blob([await englishPdf.save()], {type:'application/pdf'}),'Error metrics.pdf');
  const uploadedPaper=await app.request('/api/sources/upload',{method:'POST',raw:paperForm});
  const paper=await app.ready(uploadedPaper.data[0].id);
  answer={summary:'这篇论文研究平均绝对误差。',body:[
    '## 研究问题','作者研究平均绝对误差（mean absolute error，MAE）。[1]',
    '## 方法','示例公式为 $|x-y|$。[1]',
    '## 实验证据与局限','表 1 只报告了数据集 A 的结果。[2]'
  ].join('\n')};
  const originalPages=(await app.request('/api/wiki')).data.length;
  await page.goto(app.base+'/#/wiki?source='+paper.id);
  await page.getByRole('button',{name:'论文精读',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'整理 Wiki 知识页草稿',exact:true});
  const preview=editor.locator('.wiki-preview');
  await preview.getByText(/mean absolute error/).waitFor();
  await preview.locator('.katex .katex-html').waitFor();
  assert.match(await editor.locator('.wiki-coverage').innerText(),/2\/2/);
  assert.equal((await app.request('/api/wiki')).data.length,originalPages);
  await preview.getByRole('button',{name:'[1]',exact:true}).first().click();
  const evidence=editor.locator('details[open]').filter({hasText:'We study mean absolute error'});
  await evidence.getByRole('link',{name:'查看第 1 页整页原图',exact:true}).waitFor();
  const guideTitle=await editor.getByLabel('知识页标题',{exact:true}).inputValue();
  await editor.getByRole('button',{name:'保存知识页草稿',exact:true}).click();
  await page.getByRole('heading',{name:guideTitle,exact:true}).waitFor();
  await page.reload();
  const article=page.locator('.wiki-article');
  await article.getByRole('button',{name:'[2]',exact:true}).click();
  const results=article.locator('details[open]').filter({hasText:'Table 1 reports MAE'});
  await results.getByRole('link',{name:'打开原文 · 第 2 页',exact:true}).click();
  await page.waitForURL(url=>url.hash.startsWith('#/library/'+paper.id+'?chunk='));
  await page.locator('.reading-paper').getByText(/Table 1 reports MAE/).waitFor();
  assert.equal((await app.request('/api/wiki')).data.length,originalPages+1);
  console.log('✓ 英文论文一键生成中文导读，公式预览、引用定位、覆盖范围、保存与重读');
} finally {
  releaseTrial();
  await browser?.close(); await app.close();
  await new Promise(resolve=>model.close(resolve));
}
