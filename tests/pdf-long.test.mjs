import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { testServer } from './helpers.mjs';

async function fixture(t) {
  const s = await testServer(); t.after(() => s.close());
  await s.request('/api/auth/setup', { method: 'POST', body: { password: 'long-pdf-password' } });
  const calls = []; let block = false, blockAt = 0, release;
  const mock = createServer(async (req,res) => {
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text);const page=Number(body.messages[0].content[0].text.match(/PDF page (\d+)/)[1]); calls.push(page);
    if(block || page === blockAt)await new Promise(r=>release=r);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({markdown:`# Long document page ${page}\nVerified long PDF result for this physical page.`,blank:false,warnings:[]})},finish_reason:'stop'}]}));
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{release?.();mock.closeAllConnections();return new Promise(r=>mock.close(r));});
  await s.request('/api/settings',{method:'PUT',body:{baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,model:'long-vision'}});
  const upload=async(pages)=>{
    const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
    for(let i=0;i<pages;i++){const page=pdf.addPage();if(i===0||i===pages-1)page.drawText('Long PDF physical page test.',{font});}
    const form=new FormData();form.append('files',new Blob([await pdf.save()]),'long.pdf');
    const result=await s.request('/api/sources/upload',{method:'POST',raw:form});assert.equal(result.status,202);return result.data[0];
  };
  const wait=async fn=>{for(let i=0;i<200;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,50));}throw Error('Wait timed out '+s.logs());};
  return {s,calls,upload,wait,block(){block=true;},blockAt(page){blockAt=page;},unblock(){block=false;blockAt=0;release?.();}};
}

test('整本 PDF：暂停持久化、续跑跳过成功页、处理中分批采用和历史不变', {timeout:60000}, async t=>{
  const f=await fixture(t),{s}=f;const source=await f.upload(3),path=`/api/sources/${source.id}/ai-parse`;
  f.blockAt(2);const created=await s.request(path,{method:'POST',body:{scope:'all'}});assert.equal(created.status,202);const id=created.data.id;
  await f.wait(()=>f.calls.length===2);
  assert.equal((await s.request(`${path}/${id}/pause`,{method:'POST'})).status,200);
  f.unblock();await new Promise(r=>setTimeout(r,150));
  const partial=await s.request(`${path}/${id}/apply`,{method:'POST',body:{pages:[1]}});assert.equal(partial.status,200);
  await s.restart();assert.equal((await s.request(path)).data.status,'paused');
  assert.equal((await s.request(path,{method:'POST',body:{scope:'all'}})).status,409);
  assert.equal((await s.request(`${path}/${id}/resume`,{method:'POST'})).status,200);
  await f.wait(async()=> (await s.request(path)).data.status==='ready');
  const calls=f.calls.length; const result=(await s.request(path+'?offset=0')).data;assert.equal(result.pages.length,3);
  assert.equal(f.calls.filter(page=>page===1).length,1,'Successful page is not requested again');
  assert.equal((await s.request(`${path}/${id}/apply`,{method:'POST',body:{pages:[1]}})).status,409);
  assert.equal((await s.request(`${path}/${id}/apply`,{method:'POST',body:{pages:[2,3]}})).status,200);
  assert.equal((await s.request(path+'?offset=0')).data.applied_pages,3);
  await s.restart();assert.equal((await s.request(path)).data.status,'applied');assert.equal(f.calls.length,calls);
});

test('2501 页整本任务：重启续跑、结果分页、50 页采用边界、失败后仅处理缺页', {timeout:60000}, async t=>{
  const f=await fixture(t),{s}=f;const source=await f.upload(2501),path=`/api/sources/${source.id}/ai-parse`;
  // Ordinary extraction retains its resource limits; AI uses pdfinfo independently.
  assert.equal(source.status,'failed');
  await s.stop();
  let db=new DatabaseSync(join(s.dataDir,'knowledge.sqlite'));
  const id='persisted-long-task';
  db.prepare("INSERT INTO pdf_parse_jobs(id,source_id,status,first_page,last_page,model,base_revision,created_by,created_at,updated_at,resumable,completed_pages) VALUES(?,?,'running',1,10000,'long-vision',0,(SELECT id FROM users LIMIT 1),'2026-01-01','2026-01-01',1,2500)").run(id,source.id);
  const insert=db.prepare('INSERT INTO pdf_parse_pages(job_id,page,content) VALUES(?,?,?)');
  db.exec('BEGIN');for(let page=1;page<=2500;page++)insert.run(id,page,`Saved result physical page ${page}.`);db.exec('COMMIT');db.close();
  await s.start();await f.wait(async()=> (await s.request(path)).data.status==='ready');
  assert.deepEqual(f.calls,[2501],'Only missing final page is sent to model after restart');
  const first=(await s.request(path+'?offset=0')).data;assert.equal(first.total_pages,2501);assert.equal(first.last_page,2501);assert.equal(first.completed_pages,2501);assert.equal(first.pages.length,50);
  const last=(await s.request(path+'?offset=2500')).data;assert.equal(last.pages.length,1);assert.equal(last.pages[0].page,2501);
  assert.equal((await s.request(path)).data.pages.length,50,'Legacy polls are also bounded');
  assert.equal((await s.request(`${path}/${id}/apply`,{method:'POST'})).status,400);
  assert.equal((await s.request(`${path}/${id}/apply`,{method:'POST',body:{pages:Array.from({length:51},(_,i)=>i+1)}})).status,400);
  const adopted=await s.request(`${path}/${id}/apply`,{method:'POST',body:{pages:[2501],corrections:[{page:2501,content:'Corrected physical page 2501 transcription.'}]}});assert.equal(adopted.status,200);
  assert.equal((await s.request(`/api/sources/${source.id}`)).data.ai_pages,1);
  await s.stop();db=new DatabaseSync(join(s.dataDir,'knowledge.sqlite'));db.prepare("UPDATE pdf_parse_jobs SET status='failed' WHERE id=?").run(id);db.close();await s.start();
  assert.equal((await s.request(`${path}/${id}/resume`,{method:'POST'})).status,200);
  await f.wait(async()=> (await s.request(path)).data.status==='ready');assert.deepEqual(f.calls,[2501]);
});

test('跨任务增量复用：范围扩展只解析缺页，校对持久化，显式重做才重复调用', {timeout:60000}, async t=>{
  const f=await fixture(t),{s}=f;const source=await f.upload(3),path=`/api/sources/${source.id}/ai-parse`;
  let first=await s.request(path,{method:'POST',body:{firstPage:1,lastPage:1,resumable:true}});assert.equal(first.status,202);
  await f.wait(async()=> (await s.request(path)).data.status==='ready');assert.deepEqual(f.calls,[1]);
  let row=(await s.request(path+'?offset=0')).data.pages[0];
  const reviewed=await s.request(`${path}/${first.data.id}/review`,{method:'POST',body:{page:1,version:row.version,content:'Saved correction physical page one.',reviewed:true}});assert.equal(reviewed.status,200);
  assert.equal((await s.request(`${path}/${first.data.id}/review`,{method:'POST',body:{page:1,version:row.version,content:'Stale overwrite physical page one.',reviewed:true}})).status,409);
  const next=await s.request(path,{method:'POST',body:{scope:'all'}});assert.equal(next.status,202);
  await f.wait(async()=> (await s.request(path)).data.status==='ready');assert.deepEqual(f.calls,[1,2,3]);
  row=(await s.request(path+'?offset=0')).data.pages[0];assert.equal(row.content,'Saved correction physical page one.');assert.equal(row.reviewed,1);assert.equal(row.origin_model,'long-vision');
  await s.request(`${path}/${next.data.id}/cancel`,{method:'POST'});
  const again=await s.request(path,{method:'POST',body:{scope:'all'}});assert.equal(again.status,202);assert.equal(again.data.status,'ready');assert.deepEqual(f.calls,[1,2,3]);
  await s.request(`${path}/${again.data.id}/cancel`,{method:'POST'});
  const forced=await s.request(path,{method:'POST',body:{firstPage:2,lastPage:2,resumable:true,force:true}});assert.equal(forced.status,202);
  await f.wait(async()=> (await s.request(path)).data.status==='ready');assert.deepEqual(f.calls,[1,2,3,2]);
});

test('核查不受50页约束：范围标记、跨页持久化、版本校验与分批采用100页', {timeout:60000}, async t=>{
  const f=await fixture(t),{s}=f;const source=await f.upload(120),path=`/api/sources/${source.id}/ai-parse`;
  await s.stop();let db=new DatabaseSync(join(s.dataDir,'knowledge.sqlite'));const id='review-many-pages';
  db.prepare("INSERT INTO pdf_parse_jobs(id,source_id,status,first_page,last_page,total_pages,model,base_revision,created_by,created_at,updated_at,resumable,completed_pages) VALUES(?,?,'ready',1,120,120,'long-vision',0,(SELECT id FROM users LIMIT 1),'2026-01-01','2026-01-01',1,120)").run(id,source.id);
  const insert=db.prepare('INSERT INTO pdf_parse_pages(job_id,page,content) VALUES(?,?,?)');db.exec('BEGIN');for(let p=1;p<=120;p++)insert.run(id,p,`Recorded transcription for physical page ${p}.`);db.exec('COMMIT');db.close();await s.start();
  let detail=(await s.request(path+'?offset=50')).data;assert.equal(detail.pages[0].page,51);
  const saved=await s.request(`${path}/${id}/review`,{method:'POST',body:{page:51,version:detail.pages[0].version,content:'Saved editable correction for page fifty one.',reviewed:false}});assert.equal(saved.status,200);
  assert.equal((await s.request(`${path}/${id}/review-range`,{method:'POST',body:{firstPage:1,lastPage:100,reviewed:true}})).data.updated,100);
  await s.restart();detail=(await s.request(path+'?offset=50')).data;assert.equal(detail.reviewed_pages,100);assert.equal(detail.review_index.length,100);assert.equal(detail.pages[0].content,'Saved editable correction for page fifty one.');
  const stale=detail.review_index[0];await s.request(`${path}/${id}/review`,{method:'POST',body:{page:stale.page,version:stale.version,reviewed:true}});
  assert.equal((await s.request(`${path}/${id}/apply`,{method:'POST',body:{pages:[stale.page],requireReviewed:true,versions:{[stale.page]:stale.version}}})).status,409);
  const entries=(await s.request(path+'?offset=0')).data.review_index;
  for(let start=0;start<entries.length;start+=50){const batch=entries.slice(start,start+50);assert.equal((await s.request(`${path}/${id}/apply`,{method:'POST',body:{pages:batch.map(p=>p.page),requireReviewed:true,versions:Object.fromEntries(batch.map(p=>[p.page,p.version]))}})).status,200);}
  detail=(await s.request(path+'?offset=100')).data;assert.equal(detail.applied_pages,100);assert.equal(detail.review_index.length,0);assert.equal(detail.pages[0].reviewed,0);assert.equal(detail.pages[0].applied,0);
  assert.deepEqual(f.calls,[]);
});

test('旧任务继续也合并历史成功页，显式重做标志跨重启保留', {timeout:60000}, async t=>{
  const f=await fixture(t),{s}=f;const source=await f.upload(3),path=`/api/sources/${source.id}/ai-parse`;
  const original=await s.request(path,{method:'POST',body:{firstPage:1,lastPage:1,resumable:true}});
  await f.wait(async()=> (await s.request(path)).data.status==='ready');
  await s.request(`${path}/${original.data.id}/cancel`,{method:'POST'});
  await s.stop();let db=new DatabaseSync(join(s.dataDir,'knowledge.sqlite'));
  const id='older-existing-job';db.prepare("INSERT INTO pdf_parse_jobs(id,source_id,status,first_page,last_page,total_pages,model,base_revision,created_by,created_at,updated_at,resumable,completed_pages) VALUES(?,?,'paused',1,3,3,'long-vision',0,(SELECT id FROM users LIMIT 1),'2099-01-01','2099-01-01',1,0)").run(id,source.id);db.close();await s.start();
  assert.equal((await s.request(`${path}/${id}/resume`,{method:'POST'})).status,200);
  await f.wait(async()=> (await s.request(path)).data.status==='ready');assert.deepEqual(f.calls,[1,2,3]);
  await s.request(`${path}/${id}/cancel`,{method:'POST'});
  f.blockAt(2);const force=await s.request(path,{method:'POST',body:{firstPage:2,lastPage:2,resumable:true,force:true}});
  await f.wait(()=>f.calls.length===4);await s.request(`${path}/${force.data.id}/pause`,{method:'POST'});f.unblock();
  await s.restart();
  db=new DatabaseSync(join(s.dataDir,'knowledge.sqlite'));assert.equal(db.prepare('SELECT force_reparse FROM pdf_parse_jobs WHERE id=?').get(force.data.id).force_reparse,1);db.close();
  assert.equal((await s.request(`${path}/${force.data.id}/resume`,{method:'POST'})).status,200);
  // Query the task directly because the deliberately future-dated legacy fixture stays latest.
  await f.wait(async()=>{
    const db=new DatabaseSync(join(s.dataDir,'knowledge.sqlite'));const state=db.prepare('SELECT status FROM pdf_parse_jobs WHERE id=?').get(force.data.id).status;db.close();return state==='ready';
  });
  assert.deepEqual(f.calls,[1,2,3,2,2]);
});
