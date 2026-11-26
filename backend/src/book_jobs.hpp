#pragma once
#include "book_worker.hpp"
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>

namespace {
std::atomic<bool> stopBookWorker{false};
std::mutex bookWakeMutex;
std::condition_variable bookWake;
std::thread bookThread;
}

static Obj latestBookJob(Database &db,const QString &sid) {
  return db.one("SELECT * FROM wiki_book_jobs WHERE source_id=?", {sid});
}
static bool bookJobActive(const Obj &job) {
  return str(job,"status")=="queued" || str(job,"status")=="running";
}
static void sendBookJob(Context &c,const QString &sid,int status=200) {
  auto job=latestBookJob(c.db,sid);
  if (!job.isEmpty()) job["pause_requested"]=job["pause_requested"].toInt()!=0;
  job.remove("created_by");
  c.json(Obj{{"job",job.isEmpty()?Val(Val::Null):Val(job)}},status);
}

// Generated pages can be deleted independently between runs.
static Obj nextBookEntry(Database &db,const Obj &plan,const QString &entryId) {
  QSet<QString> existing;
  for (const auto &row:db.all("SELECT w.id FROM wiki_pages w JOIN json_each(?) e ON w.id=json_extract(e.value,'$.wiki_id')",
                               {str(plan,"outline")}))
    existing.insert(str(row.toObject(),"id"));
  for(const auto &v:bookEntries(plan)) {
    const auto entry=v.toObject();
    if ((!entryId.isEmpty() && str(entry,"id")!=entryId) || existing.contains(str(entry,"wiki_id"))) continue;
    return entry;
  }
  return {};
}

static void startBookJob(Context &c,const QString &sid) {
  const auto target=text(c.body,"entry_id",128);
  const QString scope=target.isEmpty()?"all":"chapter";
  auto &db=c.db;
  Tx tx(db);
  const auto plan=readBookPlan(db,sid);
  require(!plan.isEmpty(),409,"请先确认书籍目录。");
  const auto old=latestBookJob(db,sid);
  const bool same=str(old,"scope")==scope && str(old,"entry_id")==target;
  if(bookJobActive(old)) {
    require(same,409,"本书已有后台任务，请先暂停该任务。");
    tx.commit();sendBookJob(c,sid,202);return;
  }
  if(!target.isEmpty()) {
    const auto entries=bookEntries(plan);
    require(std::any_of(entries.begin(),entries.end(),[&](const Val &v){return str(v.toObject(),"id")==target;}),
            409,"目录已变化，请重新打开。");
  }
  const auto next=nextBookEntry(db,plan,target);
  if(next.isEmpty() && same && str(old,"status")=="done") {
    tx.commit();sendBookJob(c,sid,202);return;
  }
  require(plan["version"].toInt()==c.body["version"].toInt(-1),409,"目录已更新，请刷新后继续。");
  require(next.isEmpty() || modelSettings(db)["configured"].toBool(),400,"请先配置模型。");
  db.exec("DELETE FROM wiki_book_jobs WHERE source_id=?",{sid});
  db.insert("wiki_book_jobs",{{"id",uid()},{"source_id",sid},{"created_by",c.user["id"]},
    {"scope",scope},{"entry_id",target},{"status",next.isEmpty()?"done":"queued"},
    {"current_entry_id",next["id"]},{"processed",next["processed"].toInt()},{"plan_version",plan["version"]},{"updated_at",now()}});
  tx.commit();bookWake.notify_one();sendBookJob(c,sid,202);
}

static void changeBookJob(Context &c,const QString &sid,const QString &action) {
  Tx tx(c.db);
  const auto job=latestBookJob(c.db,sid);
  const auto id=ref(c.body,"job_id");
  require(str(job,"id")==id,409,"任务已更新，请刷新。");
  const auto status=str(job,"status");
  if(action=="pause_job") {
    if(status=="queued") c.db.update("wiki_book_jobs",id,{{"status","paused"},{"updated_at",now()}});
    if(status=="running") c.db.update("wiki_book_jobs",id,{{"pause_requested",1},{"updated_at",now()}});
  } else if(status=="failed" || status=="paused") {
    const auto plan=readBookPlan(c.db,sid);
    require(plan["version"]==job["plan_version"],409,"目录已更改，请按新目录重新开始整理。");
    c.db.update("wiki_book_jobs",id,{{"status","queued"},{"error",""},{"pause_requested",0},{"updated_at",now()}});
  }
  tx.commit();bookWake.notify_one();sendBookJob(c,sid);
}

static bool runBookBatch(Database &db) {
  Obj job,source,plan,user;
  QString entryId;
  if(db.one("SELECT 1 FROM wiki_book_jobs WHERE status='queued' LIMIT 1").isEmpty()) return false;
  Tx claim(db);
  job=db.one("SELECT * FROM wiki_book_jobs WHERE status='queued' ORDER BY updated_at,id LIMIT 1");
  if(job.isEmpty()) return false;
  const auto id=str(job,"id"), sid=str(job,"source_id");
  db.update("wiki_book_jobs",id,{{"status","running"},{"updated_at",now()}});
  claim.commit();
  try {
    plan=readBookPlan(db,sid);
    require(plan["version"]==job["plan_version"],409,"目录版本已变化，请重新开始整理。");
    const auto next=nextBookEntry(db,plan,str(job,"entry_id"));
    if(next.isEmpty()) {
      db.exec("UPDATE wiki_book_jobs SET status='done',pause_requested=0,updated_at=? WHERE id=?",{now(),id});
      return true;
    }
    entryId=str(next,"id");
    db.update("wiki_book_jobs",id,{{"current_entry_id",entryId},{"processed",next["processed"].toInt()}});
    source=db.must("sources",sid);user=db.must("users",str(job,"created_by"));
    require(user["active"].toInt()!=0 && (str(user,"role")=="owner" || str(user,"role")=="admin" || str(user,"role")=="editor"),
            403,"任务发起人已失去编辑权限。");
    CompletionOptions options;
    options.canceled=[] { return stopBookWorker.load(); };
    generateBookBatch(db,user,source,plan,entryId,id,options);
  } catch(const std::exception &e) {
    if(!stopBookWorker.load()) {
      const auto error=dynamic_cast<const Error*>(&e);
      const auto message=error && (error->status<500 || error->status==502)
        ? QString::fromUtf8(e.what()).left(1000) : QStringLiteral("章节整理出错，请稍后继续。");
      db.exec("UPDATE wiki_book_jobs SET status='failed',pause_requested=0,error=?,updated_at=? WHERE id=?",
              {message,now(),id});
      qWarning("Book job %s entry %s failed: %s",qPrintable(id),qPrintable(entryId),qPrintable(message));
    }
  }
  return true;
}

BookWorker::BookWorker() {
  Database db;
  db.exec("UPDATE wiki_book_jobs SET status=CASE WHEN pause_requested=1 THEN 'paused' ELSE 'queued' END,"
          "pause_requested=0 WHERE status='running'");
  stopBookWorker=false;
  bookThread=std::thread([] {
    while(!stopBookWorker.load()) {
      try {
        Database db;
        if(runBookBatch(db)) continue;
      } catch(const std::exception &e) {qWarning("Book worker: %s",e.what());}
      std::unique_lock<std::mutex> lock(bookWakeMutex);
      bookWake.wait_for(lock,std::chrono::seconds(1));
    }
  });
}
BookWorker::~BookWorker() {
  stopBookWorker=true;bookWake.notify_one();
  if(bookThread.joinable()) bookThread.join();
}
