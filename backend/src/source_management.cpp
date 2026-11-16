#include "core.hpp"

Obj sourceDeletionInfo(Database &db, const QString &id) {
  auto source = db.must("sources", id);
  QString reason;
  if (str(source, "status") == "processing")
    reason = "资料正在解析，请处理结束后再删除。";
  auto paper = db.one("SELECT title FROM papers WHERE source_id=?", {id});
  if (!paper.isEmpty())
    reason = "已关联论文《" + str(paper, "title") + "》，请先移除论文档案及其对比引用。";
  auto wiki = db.all("SELECT DISTINCT w.id,w.title FROM wiki_pages w JOIN wiki_evidence e ON e.page_id=w.id "
                     "JOIN chunks ch ON ch.id=e.chunk_id WHERE ch.source_id=? ORDER BY w.title", {id});
  if (!wiki.isEmpty()) {
    QStringList titles;
    for (auto value : wiki)
      if (titles.size() < 3)
        titles << "《" + str(value.toObject(), "title") + "》";
    reason += (reason.isEmpty() ? "" : " ") + QString("仍被 %1 个 Wiki 知识页引用（%2），请先移除原文引用。")
                                                    .arg(wiki.size()).arg(titles.join("、"));
  }
  return {{"id", id}, {"title", source["title"]}, {"size", source["size"]},
          {"_version", source["_version"]}, {"canDelete", reason.isEmpty()}, {"reason", reason},
          {"notes", db.one("SELECT count(*) count FROM notes WHERE source_id=?", {id})["count"]},
          {"wiki", wiki}, {"paper", paper}};
}

void deleteSourceRecord(Database &db, const QString &id, const Obj &user) {
  auto info = sourceDeletionInfo(db, id);
  require(info["canDelete"].toBool(), 409, str(info, "reason"));
  db.exec("DELETE FROM resource_versions WHERE kind='notes' AND target_id IN "
          "(SELECT id FROM notes WHERE source_id=?)", {id});
  db.exec("DELETE FROM sources WHERE id=?", {id});
  db.exec("DELETE FROM comments WHERE kind='source' AND target_id=?", {id});
  db.exec("DELETE FROM tasks WHERE kind='source' AND target_id=?", {id});
  db.exec("DELETE FROM resource_versions WHERE kind='sources' AND target_id=?", {id});
  db.activity(user, "source", "删除了《" + str(info, "title") + "》");
}
void deleteSourceFiles(const QString &id) {
  QFile::remove(dataDir + "/uploads/" + id);
  QDir(dataDir + "/pdf-previews/" + id).removeRecursively();
}

bool sourceManagementRoutes(Context &c) {
  auto p = c.path;
  if (p.size() < 3 || p[1] != "sources" || p[2] != "batch-delete" || !c.method("POST"))
    return false;
  const bool preview = p.size() == 4 && p[3] == "preview";
  if (!preview && p.size() != 3)
    return false;
  c.needEditor();
  auto ids = strings(c.body, "ids", 100);
  require(!ids.isEmpty(), 400, "请先选择要删除的资料，每批最多 100 份。");
  auto versions = c.body["versions"].toObject();
  for (auto value : ids) {
    auto id = value.toString();
    require(!QUuid(id).isNull(), 400, "选择的资料 ID 无效。");
    if (!preview)
      require(versions[id].isDouble() && versions[id].toDouble() >= 1 &&
                  versions[id].toDouble() == versions[id].toInt(),
              400, "请先预览并确认所选资料的最新版本。");
  }
  Arr items, deleted, blocked;
  auto &db = c.db;
  for (auto value : ids) {
    auto id = value.toString();
    Obj item{{"id", id}, {"title", "已移除的资料"}, {"canDelete", false}};
    try {
      if (preview) {
        item = sourceDeletionInfo(db, id);
      } else {
        Tx tx(db);
        item = sourceDeletionInfo(db, id);
        require(item["_version"].toInt() == versions[id].toInt(), 409,
                "这份资料已被更新，请重新确认后删除。");
        deleteSourceRecord(db, id, c.user);
        tx.commit();
        deleteSourceFiles(id);
        deleted.append(item);
      }
    } catch (const Error &error) {
      item["canDelete"] = false;
      item["reason"] = error.status >= 500 ? "删除未完成，请稍后重试。" : QString::fromUtf8(error.what());
    } catch (const std::exception &) {
      item["canDelete"] = false;
      item["reason"] = "删除未完成，请稍后重试。";
    }
    items.append(item);
    if (!item["canDelete"].toBool())
      blocked.append(item);
  }
  c.json(preview ? Obj{{"items", items}, {"deletableCount", items.size() - blocked.size()},
                       {"blockedCount", blocked.size()}}
                 : Obj{{"deleted", deleted}, {"blocked", blocked}, {"deletedCount", deleted.size()},
                       {"blockedCount", blocked.size()}});
  return true;
}
