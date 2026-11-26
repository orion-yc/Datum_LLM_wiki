#include "core.hpp"
#include <mutex>

namespace {
constexpr qint64 maxFile = 250LL * 1024 * 1024;
constexpr qint64 chunkSize = 8LL * 1024 * 1024;
constexpr qint64 lifetime = 60 * 60;
std::mutex uploadMutex;
QString root() { return dataDir + "/upload-staging"; }
QString manifestPath(const QString &dir) { return dir + "/manifest.json"; }
Obj manifest(const QString &dir) {
  return QJsonDocument::fromJson(readFile(manifestPath(dir))).object();
}
void save(const QString &dir, const Obj &value) {
  QSaveFile file(manifestPath(dir));
  auto raw = pack(value).toUtf8();
  require(file.open(QIODevice::WriteOnly) && file.write(raw) == raw.size() && file.commit(),
          500, "无法保存上传进度。");
}
void touch(const QString &dir, Obj value) {
  value["expires"] = double(QDateTime::currentSecsSinceEpoch() + lifetime);
  save(dir, value);
}
qint64 integer(const Val &v, qint64 maximum, const QString &message) {
  auto n = v.toDouble(-1);
  require(v.isDouble() && n >= 0 && n <= maximum && n == double(qint64(n)), 400, message);
  return qint64(n);
}
}

bool uploadRoutes(Context &c) {
  auto p = c.path;
  if (p.size() < 2 || p[0] != "api" || p[1] != "uploads")
    return false;
  c.needEditor();
  std::unique_lock lock(uploadMutex);
  auto owner = str(c.user, "id");
  if (p.size() == 2 && c.method("POST")) {
    auto files = c.body["files"].toArray();
    require(c.body["files"].isArray() && !files.isEmpty() && files.size() <= 5, 400,
            "每次请选择 1 至 5 份资料。");
    auto category = choice(c.body, "category", categories, "个人学习");
    auto parseMode = choice(c.body, "parseMode", {"standard", "ai"}, "standard");
    auto aiPages = c.body.contains("aiPages")
                       ? integer(c.body["aiPages"], 50, "AI 解析每次可选择 1 至 50 页。")
                       : 10;
    require(aiPages >= 1, 400, "AI 解析每次可选择 1 至 50 页。");
    if (parseMode == "ai")
      require(modelSettings(c.db)["configured"].toBool(), 400,
              "请先在空间设置中连接支持图片输入的模型。");
    Arr descriptors;
    for (auto value : files) {
      auto f = value.toObject();
      auto filename = QFileInfo(text(f, "name", 240, true)).fileName();
      require(!filename.contains(QRegularExpression("[\\r\\n\\x00]")) &&
                  QStringList{"pdf", "md", "markdown", "txt"}.contains(
                      QFileInfo(filename).suffix().toLower()),
              400, "请上传 PDF、Markdown 或 TXT 文件。");
      auto size = integer(f["size"], maxFile, "单份资料不能超过 250 MB。");
      require(size > 0, 400, "不能上传空文件。");
      descriptors.append(Obj{{"name", filename}, {"size", double(size)}});
    }
    require(QDir().mkpath(root()), 500, "无法创建上传目录。");
    int total = 0, own = 0;
    for (auto entry : QDir(root()).entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot)) {
      auto m = manifest(entry.absoluteFilePath());
      if (m["expires"].toDouble() <= QDateTime::currentSecsSinceEpoch()) {
        QDir(entry.absoluteFilePath()).removeRecursively();
        continue;
      }
      ++total;
      if (str(m, "owner") == owner)
        ++own;
    }
    require(total < 8 && own < 2, 429, "未完成的上传较多，请稍后重试或取消之前的上传。");
    auto id = uid(), dir = root() + '/' + id;
    require(QDir().mkpath(dir), 500, "无法创建上传目录。");
    try {
      touch(dir, Obj{{"owner", owner}, {"category", category}, {"files", descriptors},
                     {"parseMode", parseMode}, {"aiPages", int(aiPages)}, {"aiAll", c.body["aiAll"].toBool()}});
    } catch (...) {
      QDir(dir).removeRecursively();
      throw;
    }
    c.json(Obj{{"id", id}, {"chunkSize", 1024 * 1024}, {"maxChunkSize", 4 * 1024 * 1024}}, 201);
    return true;
  }
  require(p.size() >= 3 && QRegularExpression("^[a-f0-9-]{36}$").match(p[2]).hasMatch(),
          404, "上传任务不存在。");
  auto dir = root() + '/' + p[2];
  require(QFile::exists(manifestPath(dir)), 404, "上传任务不存在或已结束。");
  auto m = manifest(dir);
  require(str(m, "owner") == owner, 404, "上传任务不存在。");
  require(m["expires"].toDouble() > QDateTime::currentSecsSinceEpoch(), 410,
          "上传任务已过期，请重新选择文件。");
  if (p.size() == 3 && c.method("DELETE")) {
    require(QDir(dir).removeRecursively(), 500, "无法取消上传。");
    c.json(Obj{{"ok", true}});
    return true;
  }
  auto files = m["files"].toArray();
  if (p.size() == 3 && c.method("GET")) {
    Arr offsets;
    for (int i = 0; i < files.size(); ++i) {
      QFileInfo file(dir + '/' + QString::number(i));
      offsets.append(double(file.exists() ? file.size() : 0));
    }
    touch(dir, m);
    c.json(Obj{{"offsets", offsets}});
    return true;
  }
  if (p.size() == 4 && c.method("PUT")) {
    bool validIndex = false, validOffset = false;
    auto index = p[3].toInt(&validIndex);
    auto offset = qs(c.req.get_param_value("offset")).toLongLong(&validOffset);
    require(validIndex && index >= 0 && index < files.size() && validOffset && offset >= 0,
            400, "无效的上传位置。");
    auto expected = qint64(files[index].toObject()["size"].toDouble());
    auto length = qint64(c.req.body.size());
    require(length > 0 && length <= chunkSize && offset <= expected && length <= expected - offset,
            400, "上传分块大小不正确。");
    QFile file(dir + '/' + QString::number(index));
    require(file.open(QIODevice::ReadWrite), 500, "无法写入上传文件。");
    if (file.size() >= offset + length) {
      require(file.seek(offset) && file.read(length) == QByteArray(c.req.body.data(), length),
              409, "分块内容与已保存数据不一致，请重新选择文件。");
      touch(dir, m);
      c.json(Obj{{"offset", double(offset + length)}});
      return true;
    }
    require(file.size() == offset, 409, "上传位置不匹配，请刷新上传进度后重试。");
    require(file.seek(offset), 500, "无法定位上传文件。");
    if (file.write(c.req.body.data(), length) != length || !file.flush()) {
      file.resize(offset);
      throw Error(500, "上传分块未保存，请重新上传。");
    }
    touch(dir, m);
    c.json(Obj{{"offset", double(offset + length)}});
    return true;
  }
  if (p.size() == 4 && p[3] == "complete" && c.method("POST")) {
    Arr rows;
    QSet<QString> hashes;
    for (int i = 0; i < files.size(); ++i) {
      auto f = files[i].toObject();
      QFile file(dir + '/' + QString::number(i));
      require(file.open(QIODevice::ReadOnly) && file.size() == qint64(f["size"].toDouble()),
              409, "文件尚未上传完整。");
      QCryptographicHash hash(QCryptographicHash::Sha256);
      require(hash.addData(&file), 500, "无法校验上传文件。");
      auto fingerprint = QString::fromLatin1(hash.result().toHex());
      require(!hashes.contains(fingerprint), 409, "本批次包含内容完全相同的文件。本批次未导入。");
      hashes.insert(fingerprint);
      auto filename = str(f, "name"), id = uid();
      rows.append(Obj{{"id", id}, {"title", QFileInfo(filename).completeBaseName()},
                      {"filename", filename},
                      {"type", QFileInfo(filename).suffix().toLower() == "pdf" ? "pdf" : "markdown"},
                      {"category", m["category"]}, {"size", f["size"]},
                      {"content_hash", fingerprint}, {"created_at", now()}, {"updated_at", now()}});
    }
    int moved = 0;
    try {
      Tx tx(c.db);
      for (auto value : rows) {
        auto row = value.toObject();
        auto existing = c.db.one("SELECT id,title FROM sources WHERE content_hash=? LIMIT 1",
                                 {str(row, "content_hash")});
        require(existing.isEmpty(), 409,
                "资料内容与已有《" + str(existing, "title") +
                    "》完全相同，请在资料库中打开已有资料。本批次未导入。");
        require(QFile::rename(dir + '/' + QString::number(moved),
                              dataDir + "/uploads/" + str(row, "id")),
                500, "无法保存原始资料。");
        ++moved;
        c.db.insert("sources", row);
        if (str(m, "parseMode") == "ai" && str(row, "type") == "pdf")
          queuePdfParse(c.db, str(row, "id"),
                         m["aiAll"].toBool() ? Obj{{"scope", "all"}} : Obj{{"firstPage", 1}, {"lastPage", m["aiPages"]}, {"resumable", true}}, c.user);
      }
      tx.commit();
    } catch (...) {
      for (int i = 0; i < moved; ++i)
        QFile::rename(dataDir + "/uploads/" + str(rows[i].toObject(), "id"),
                      dir + '/' + QString::number(i));
      throw;
    }
    QDir(dir).removeRecursively();
    lock.unlock();
    Arr result;
    for (auto value : rows) {
      auto id = str(value.toObject(), "id");
      ingest(c.db, id, c.user);
      result.append(c.db.must("sources", id));
    }
    c.json(result, 202);
    return true;
  }
  throw Error(404, "接口不存在。");
}
