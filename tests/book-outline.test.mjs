import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { testServer } from './helpers.mjs';

test('书籍目录定位 PDF 书签、校对印刷页码，以及 Markdown 中共享起始位置的章和节', async t => {
  const server = await testServer();
  t.after(() => server.close());
  await server.request('/api/auth/setup', {method:'POST',body:{password:'book-outline-test'}});
  async function plan(filename, data) {
    const form = new FormData();
    form.append('files',new Blob([data]),filename);
    const upload = await server.request('/api/sources/upload',{method:'POST',raw:form});
    assert.equal(upload.status,202);
    const source = await server.ready(upload.data[0].id);
    const res = await server.request('/api/wiki/book/'+source.id);
    assert.equal(res.status,200,JSON.stringify(res.data));
    return res.data.entries;
  }
  const markdown = '# 一本教材\n## 第一章 入门\n### 记号\n开始了解记号。\n## 第二章 方法\n掌握新方法。';
  assert.deepEqual((await plan('原始目录.md',markdown)).map(e=>[e.title,e.first,e.level]),[
    ['第一章 入门',1,1],['记号',1,2],['第二章 方法',2,1]
  ]);
  const pdf = await PDFDocument.create();
  const labels = ['Table of Contents\nFirst topic ..... 1\nSecond topic ..... 3','Preface',
    'First topic','More on the first topic','Second topic','Exercises'];
  for (const label of labels) pdf.addPage([400,600]).drawText(label,{x:28,y:550,size:15});
  const printed = await plan('Printed contents.pdf',await pdf.save());
  for (const [title,page] of [['First topic',3],['Second topic',5]]) {
    assert.ok(printed.some(e=>e.title===title && e.first===page && e.origin==='toc'));
  }
  const context = pdf.context;
  const outlines = context.nextRef(), a = context.nextRef(), b = context.nextRef();
  context.assign(outlines,context.obj({Type:'Outlines',First:a,Last:b,Count:2}));
  context.assign(a,context.obj({Title:PDFString.of('Chapter 1 Getting started'),Parent:outlines,Next:b,
    Dest:[pdf.getPages()[2].ref,'Fit']}));
  context.assign(b,context.obj({Title:PDFString.of('Chapter 2 Practice'),Parent:outlines,Prev:a,
    Dest:[pdf.getPages()[4].ref,'Fit']}));
  pdf.catalog.set(PDFName.of('Outlines'),outlines);
  const bookmarks=(await plan('Bookmarked contents.pdf',await pdf.save())).filter(e=>e.origin==='bookmark');
  assert.deepEqual(bookmarks.map(e=>[e.title,e.first]),[['Chapter 1 Getting started',3],['Chapter 2 Practice',5]]);
});

test('印刷目录中同页的节和两个小节保留顺序并可确认',async t=>{
  const app=await testServer();
  t.after(()=>app.close());
  await app.request('/api/auth/setup',{method:'POST',body:{password:'section-fixture-test'}});
  const doc=await PDFDocument.create();
  for(const lines of [
    ['Contents','Chapter 2 Imaging ..... 1','2.4 Sampling ..... 2','2.4.1 Basics ..... 2','2.4.2 Pixels ..... 2','2.5 Reconstruction ..... 3'],
    ['Chapter 2 Imaging'],['2.4 Sampling','2.4.1 Basics','2.4.2 Pixels'],['2.5 Reconstruction']
  ]) doc.addPage([500,700]).drawText(lines.join('\n'),{x:32,y:630,size:14});
  const data=new FormData(); data.append('files',new Blob([await doc.save()]),'Image sampling.pdf');
  const up=await app.request('/api/sources/upload',{method:'POST',raw:data});
  const book=await app.ready(up.data[0].id); const path='/api/wiki/book/'+book.id;
  const result=await app.request(path,{method:'POST',body:{action:'detect',version:0,toc_first:1,toc_last:1}});
  assert.equal(result.status,200,JSON.stringify(result.data));
  const entries=result.data.entries;
  const same=entries.filter(e=>/^2\.4/.test(e.title));
  assert.deepEqual(same.map(e=>[e.title,e.level,e.first]),[['2.4 Sampling',2,3],['2.4.1 Basics',3,3],['2.4.2 Pixels',3,3]]);
  assert.equal(new Set(same.map(e=>e.id)).size,3);
  assert.ok(same.every(e=>e.toc_page===1 && e.origin==='toc'));
  const confirmed=await app.request(path,{method:'POST',body:{action:'confirm',version:0,entries}});
  assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
  assert.equal((await app.request(path)).data.entries.filter(e=>e.level===3).length,2);
});
