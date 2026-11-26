import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { open, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { testServer } from '../tests/helpers.mjs';
import assert from 'node:assert/strict';
const folder=await mkdtemp('/tmp/datum-upload-retry-'),server=await testServer();let browser;
try {
 await server.request('/api/auth/setup',{method:'POST',body:{password:'retry-upload-password'}});
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);pdf.addPage().drawText('Upload resume regression.',{font});
 const data=Buffer.from(await pdf.save({useObjectStreams:false})),split=data.lastIndexOf('startxref'),size=35*1024*1024,path=join(folder,'retry.pdf');
 const file=await open(path,'w');await file.write(data.subarray(0,split));const tail=data.subarray(split);await file.write(tail,0,tail.length,size-tail.length);await file.close();
 browser=await chromium.launch({headless:true});const context=await browser.newContext();await context.addCookies([{name:'zhixu_session',value:server.getCookie().split('=')[1],url:server.base}]);
 const page=await context.newPage();let lost=false,fail=true,created=0,deletes=0;const offsets=[];
 page.on('request',r=>{if(r.url().endsWith('/api/uploads')&&r.method()==='POST')created++;if(r.method()==='DELETE')deletes++;});
 await page.route('**/api/uploads/*/0?offset=*',async route=>{
  const offset=Number(new URL(route.request().url()).searchParams.get('offset'));offsets.push(offset);
  assert.ok(Number(route.request().headers()['content-length'] || 0)<=4*1024*1024);
  if(!lost){lost=true;const response=await route.fetch();assert.equal(response.status(),200);await route.fulfill({status:504,contentType:'text/html',body:'<html>Gateway Timeout</html>'});return;}
  if(fail&&offset>=2*1024*1024){await route.fulfill({status:504,contentType:'text/html',body:'<html>Gateway Timeout</html>'});return;}
  await route.continue();
 });
 await page.goto(server.base);await page.getByRole('navigation',{name:'主要功能'}).getByRole('button',{name:'我的资料库',exact:true}).click();await page.getByRole('button',{name:'上传资料',exact:true}).click();await page.getByLabel('选择学习资料').setInputFiles(path);
 await page.getByRole('button',{name:'上传 1 份资料',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'上传进度已保留'}).waitFor({timeout:30000});
 assert.equal(created,1);assert.equal(deletes,0);assert.ok(offsets.filter(o=>o===0).length===2,'Lost acknowledgement retries identical saved chunk');
 fail=false;const boundary=offsets.length;
 await page.getByRole('button',{name:'上传 1 份资料',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden',timeout:90000});
 assert.equal(created,1);assert.equal(deletes,0);assert.equal(offsets[boundary],2*1024*1024,'Resume starts at server saved offset');
 const sources=(await server.request('/api/sources')).data;assert.equal(sources.length,1);assert.equal(sources[0].size,size);assert.equal(sources[0].status,'ready');
 console.log('✓ 自适应分块、落盘后504丢响应幂等重试、连续504后保留任务、点击重试断点续传、无重复资料');
}finally{await browser?.close();await server.close();await rm(folder,{recursive:true,force:true});}
