#include "core.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <mutex>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

QString dataDir;
const QStringList categories = {"个人学习", "论文研究", "项目知识", "故障经验", "团队百科"};
static const QStringList jsonFields = {"tags",          "prerequisites", "steps",
                                       "knowledge_ids", "citations",     "paper_ids",
                                       "dimensions",    "cells",         "snapshot", "warnings"};
QString uid() {
  return QUuid::createUuid().toString(QUuid::WithoutBraces);
}
QString now() {
  return QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs);
}
QString calendarDate(QDateTime at) {
  QTimeZone zone(qgetenv("APP_TIMEZONE").isEmpty() ? QByteArray("Asia/Shanghai")
                                                   : qgetenv("APP_TIMEZONE"));
  require(zone.isValid(), 500, "APP_TIMEZONE 无效。");
  return at.toTimeZone(zone).date().toString(Qt::ISODate);
}
QString pack(Val v) {
  return QString::fromUtf8(v.isArray()
                               ? QJsonDocument(v.toArray()).toJson(QJsonDocument::Compact)
                               : QJsonDocument(v.toObject()).toJson(QJsonDocument::Compact));
}
QString text(const Obj &b, const char *key, int max, bool required, QString fallback) {
  if (!b.contains(key)) {
    require(!required || !fallback.isEmpty(), 400, QString("请填写 %1。").arg(key));
    return fallback;
  }
  require(b[key].isString(), 400, QString("%1 必须是文字。").arg(key));
  auto value = b[key].toString().trimmed();
  require(value.size() <= max && (!required || !value.isEmpty()), 400,
          QString("%1 不能为空且不能超过 %2 个字符。").arg(key).arg(max));
  return value;
}
QString ref(const Obj &b, const char *key) {
  auto v = b.value(key);
  if (v.isNull() || v.isUndefined() || v.toString().isEmpty())
    return {};
  require(v.isString() && !QUuid(v.toString()).isNull(), 400, "无效的关联 ID。");
  return v.toString();
}
QString date(const Obj &b, const char *key) {
  if (b[key].isNull() || !b.contains(key) || b[key].toString().isEmpty())
    return {};
  auto v = text(b, key, 10);
  require(QDate::fromString(v, Qt::ISODate).isValid() &&
              QDate::fromString(v, Qt::ISODate).toString(Qt::ISODate) == v,
          400, "日期无效，请使用 YYYY-MM-DD。");
  return v;
}
QString choice(const Obj &b, const char *key, const QStringList &values, QString fallback) {
  auto value = text(b, key, 100, false, fallback);
  require(values.contains(value), 400, QString("%1 的选项无效。").arg(key));
  return value;
}
Arr strings(const Obj &b, const char *key, int limit) {
  if (!b.contains(key))
    return {};
  require(b[key].isArray() && b[key].toArray().size() <= limit, 400, "列表过长或格式无效。");
  Arr result;
  for (auto v : b[key].toArray()) {
    require(v.isString() && !v.toString().trimmed().isEmpty() && v.toString().size() <= 200, 400,
            "列表内容无效。");
    require(!result.contains(v.toString().trimmed()), 400, "列表中不能有重复项。");
    result.append(v.toString().trimmed());
  }
  return result;
}
QByteArray readFile(const QString &path) {
  QFile f(path);
  require(f.open(QIODevice::ReadOnly), 500, "无法读取文件。");
  return f.readAll();
}
void writeFile(const QString &path, const QByteArray &content) {
  QSaveFile f(path);
  require(f.open(QIODevice::WriteOnly) && f.write(content) == content.size() && f.commit(), 500,
          "无法保存文件。");
}
QString randomHex(int size) {
  QByteArray b(size, 0);
  require(RAND_bytes(reinterpret_cast<unsigned char *>(b.data()), size) == 1, 500,
          "随机数生成失败。");
  return QString::fromLatin1(b.toHex());
}
QString digest(const QString &s) {
  return QString::fromLatin1(
      QCryptographicHash::hash(s.toUtf8(), QCryptographicHash::Sha256).toHex());
}
static QByteArray derived(const QString &password, const QString &salt) {
  QByteArray key(64, 0), p = password.toUtf8(), s = salt.toUtf8();
  require(EVP_PBE_scrypt(p.data(), size_t(p.size()),
                         reinterpret_cast<const unsigned char *>(s.data()), size_t(s.size()), 16384,
                         8, 1, 64 * 1024 * 1024, reinterpret_cast<unsigned char *>(key.data()),
                         64) == 1,
          500, "密码处理失败。");
  return key;
}
QString hashPassword(const QString &p) {
  auto salt = randomHex(16);
  return salt + ":" + QString::fromLatin1(derived(p, salt).toHex());
}
bool verifyPassword(const QString &p, const QString &stored) {
  auto parts = stored.split(':');
  if (parts.size() != 2 || parts[1].size() != 128)
    return false;
  auto expected = QByteArray::fromHex(parts[1].toLatin1()), candidate = derived(p, parts[0]);
  return expected.size() == candidate.size() &&
         CRYPTO_memcmp(candidate.data(), expected.data(), size_t(candidate.size())) == 0;
}
static QByteArray encryptionKey;
QString encrypt(const QString &value) {
  if (value.isEmpty())
    return {};
  auto plain = value.toUtf8(), iv = QByteArray::fromHex(randomHex(12).toLatin1());
  QByteArray out(plain.size() + 16, 0), tag(16, 0);
  int n = 0, total = 0;
  auto ctx = EVP_CIPHER_CTX_new();
  require(ctx, 500, "加密失败。");
  bool ok = EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr,
                               reinterpret_cast<const unsigned char *>(encryptionKey.data()),
                               reinterpret_cast<const unsigned char *>(iv.data())) == 1;
  ok = ok && EVP_EncryptUpdate(ctx, reinterpret_cast<unsigned char *>(out.data()), &n,
                               reinterpret_cast<const unsigned char *>(plain.data()),
                               int(plain.size())) == 1;
  total = n;
  ok = ok &&
       EVP_EncryptFinal_ex(ctx, reinterpret_cast<unsigned char *>(out.data() + total), &n) == 1;
  total += n;
  ok = ok && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag.data()) == 1;
  EVP_CIPHER_CTX_free(ctx);
  require(ok, 500, "加密失败。");
  out.resize(total);
  return QString::fromLatin1(iv.toBase64() + '.' + tag.toBase64() + '.' + out.toBase64());
}
QString decrypt(const QString &value) {
  if (value.isEmpty())
    return {};
  auto p = value.toLatin1().split('.');
  require(p.size() == 3, 500, "密钥格式无效。");
  auto iv = QByteArray::fromBase64(p[0]), tag = QByteArray::fromBase64(p[1]),
       body = QByteArray::fromBase64(p[2]);
  require(iv.size() == 12 && tag.size() == 16, 500, "密钥格式无效。");
  QByteArray out(body.size() + 16, 0);
  int n = 0, total = 0;
  auto ctx = EVP_CIPHER_CTX_new();
  require(ctx, 500, "解密失败。");
  bool ok = EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr,
                               reinterpret_cast<const unsigned char *>(encryptionKey.data()),
                               reinterpret_cast<const unsigned char *>(iv.data())) == 1;
  ok = ok && EVP_DecryptUpdate(ctx, reinterpret_cast<unsigned char *>(out.data()), &n,
                               reinterpret_cast<const unsigned char *>(body.data()),
                               int(body.size())) == 1;
  total = n;
  ok = ok && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, 16, tag.data()) == 1;
  ok = ok &&
       EVP_DecryptFinal_ex(ctx, reinterpret_cast<unsigned char *>(out.data() + total), &n) == 1;
  total += n;
  EVP_CIPHER_CTX_free(ctx);
  require(ok, 500, "无法解密模型密钥，请恢复原加密文件。");
  out.resize(total);
  return QString::fromUtf8(out);
}
Database::Database() : name(uid()), connection(QSqlDatabase::addDatabase("QSQLITE", name)) {
  connection.setDatabaseName(dataDir + "/knowledge.sqlite");
  connection.setConnectOptions("QSQLITE_BUSY_TIMEOUT=10000");
  require(connection.open(), 500, "数据库无法打开。");
  exec("PRAGMA foreign_keys=ON");
}
Database::~Database() {
  connection.close();
  connection = QSqlDatabase();
  QSqlDatabase::removeDatabase(name);
}
static QSqlQuery query(QSqlDatabase &db, const QString &sql, const QVariantList &args) {
  QSqlQuery q(db);
  if (!q.prepare(sql))
    throw Error(500, q.lastError().text());
  for (const auto &a : args)
    q.addBindValue(a);
  if (!q.exec())
    throw Error(500, q.lastError().text());
  return q;
}
void Database::exec(const QString &sql, const QVariantList &args) {
  query(connection, sql, args);
}
Arr Database::all(const QString &sql, const QVariantList &args) {
  auto q = query(connection, sql, args);
  Arr rows;
  while (q.next()) {
    Obj row;
    auto record = q.record();
    for (int i = 0; i < record.count(); i++) {
      auto key = record.fieldName(i);
      auto v = q.value(i);
      if (v.isNull())
        row[key] = Val::Null;
      else if (jsonFields.contains(key)) {
        auto doc = QJsonDocument::fromJson(v.toByteArray());
        row[key] = doc.isArray() ? Val(doc.array()) : Val(doc.object());
      } else if (key == "draft")
        row[key] = v.toBool();
      else
        row[key] = Val::fromVariant(v);
    }
    rows.append(row);
  }
  return rows;
}
Obj Database::one(const QString &sql, const QVariantList &args) {
  auto rows = all(sql, args);
  return rows.isEmpty() ? Obj{} : rows[0].toObject();
}
Obj Database::decorate(const QString &table, Obj row) {
  if (row.isEmpty())
    return row;
  auto v = one("SELECT version FROM resource_versions WHERE kind=? AND target_id=?",
               {table, str(row, "id")});
  row["_version"] = v.isEmpty() ? 1 : v["version"].toInt();
  if (table == "sources" && str(row, "type") == "pdf") {
    auto id = str(row, "id");
    row["ai_parse"] = one("SELECT * FROM pdf_parse_jobs WHERE source_id=? ORDER BY created_at DESC,id DESC LIMIT 1", {id});
    row["ai_pages"] = one("SELECT count(DISTINCT page) count FROM chunks WHERE source_id=? AND active=1 AND parse_job_id<>''", {id})["count"];
  }
  return row;
}
Obj Database::must(const QString &table, const QString &id) {
  auto row = one("SELECT * FROM " + table + " WHERE id=?", {id});
  require(!row.isEmpty(), 404, "内容不存在或已被删除。");
  return decorate(table, row);
}
Arr Database::list(const QString &table) {
  auto rows = all("SELECT * FROM " + table + " ORDER BY " +
                  (table == "chunks" ? "source_id,position" : "created_at DESC"));
  Arr out;
  for (auto r : rows)
    out.append(decorate(table, r.toObject()));
  return out;
}
static QVariant bind(Val v) {
  return v.isNull() || v.isUndefined()
             ? QVariant(QMetaType::fromType<QString>())
             : (v.isArray() || v.isObject() ? QVariant(pack(v)) : v.toVariant());
}
void Database::insert(const QString &table, const Obj &row) {
  QStringList columns, marks;
  QVariantList args;
  for (auto i = row.begin(); i != row.end(); ++i) {
    columns << i.key();
    marks << "?";
    args << bind(i.value());
  }
  exec("INSERT INTO " + table + "(" + columns.join(',') + ") VALUES(" + marks.join(',') + ")",
       args);
}
void Database::update(const QString &table, const QString &id, const Obj &row) {
  QStringList columns;
  QVariantList args;
  for (auto i = row.begin(); i != row.end(); ++i) {
    columns << i.key() + "=?";
    args << bind(i.value());
  }
  args << id;
  exec("UPDATE " + table + " SET " + columns.join(',') + " WHERE id=?", args);
}
QString Database::config(const QString &key) {
  return str(one("SELECT value FROM config WHERE key=?", {key}), "value");
}
void Database::config(const QString &key, const QString &value) {
  exec("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET "
       "value=excluded.value",
       {key, value});
}
void Database::checkVersion(const QString &table, const QString &id, const Obj &body) {
  auto item = must(table, id);
  if (body.contains("_version"))
    require(body["_version"].toInt(-1) == item["_version"].toInt(), 409,
            "其他成员已更新这条内容，请刷新后重新编辑；当前输入尚未保存。");
}
void Database::bump(const QString &table, const QString &id) {
  exec("INSERT INTO resource_versions(kind,target_id,version) VALUES(?,?,2) ON "
       "CONFLICT(kind,target_id) DO UPDATE SET version=version+1",
       {table, id});
}
void Database::activity(const Obj &u, const QString &kind, const QString &label) {
  insert("activity", {{"id", uid()},
                      {"kind", kind},
                      {"label", label},
                      {"actor_id", u.value("id")},
                      {"actor_name", str(u, "name")},
                      {"created_at", now()}});
}
void Database::initialize() {
  if (!one("SELECT name FROM sqlite_master WHERE type='table' AND name='config'").isEmpty() &&
      config("schema_version") != "4") {
    require(QDir().mkpath(dataDir + "/backups"), 500, "无法创建迁移备份目录。");
    auto backup = dataDir + "/backups/before-cpp-" +
                  QDateTime::currentDateTimeUtc().toString("yyyyMMdd-HHmmss-zzz") + "-" + uid();
    exec("VACUUM INTO ?", {backup + ".sqlite"});
    QFile::setPermissions(backup + ".sqlite", QFile::ReadOwner | QFile::WriteOwner);
    if (QFile::exists(dataDir + "/.encryption-key")) {
      require(QFile::copy(dataDir + "/.encryption-key", backup + ".key"), 500,
              "无法备份加密密钥。");
      QFile::setPermissions(backup + ".key", QFile::ReadOwner | QFile::WriteOwner);
    }
  }
  exec("PRAGMA journal_mode=WAL");
  const QString legacy = QString::fromUtf8(
#include "schema.inc"
  );
  for (auto statement : legacy.split(';', Qt::SkipEmptyParts))
    if (!statement.trimmed().isEmpty())
      exec(statement);
  const QString sql = R"SQL(
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')),active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS single_owner ON users(role) WHERE role='owner';
CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,role TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),expires TEXT NOT NULL,used_by TEXT REFERENCES users(id),revoked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resource_versions(kind TEXT NOT NULL,target_id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(kind,target_id));
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,kind TEXT NOT NULL,target_id TEXT NOT NULL,author_id TEXT NOT NULL REFERENCES users(id),content TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS comments_target ON comments(kind,target_id);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,assignee_id TEXT REFERENCES users(id),created_by TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'todo',due_date TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS papers(id TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE REFERENCES sources(id) ON DELETE RESTRICT,title TEXT NOT NULL,authors TEXT NOT NULL DEFAULT '',year INTEGER,venue TEXT NOT NULL DEFAULT '',doi TEXT NOT NULL DEFAULT '',url TEXT NOT NULL DEFAULT '',abstract TEXT NOT NULL DEFAULT '',method TEXT NOT NULL DEFAULT '',dataset TEXT NOT NULL DEFAULT '',metrics TEXT NOT NULL DEFAULT '',limitations TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comparisons(id TEXT PRIMARY KEY,title TEXT NOT NULL,question TEXT NOT NULL,paper_ids TEXT NOT NULL,dimensions TEXT NOT NULL,cells TEXT NOT NULL DEFAULT '[]',conclusion TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'draft',reviewer_id TEXT REFERENCES users(id),created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comparison_history(id TEXT PRIMARY KEY,comparison_id TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,version INTEGER NOT NULL,snapshot TEXT NOT NULL,author_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,UNIQUE(comparison_id,version));
)SQL";
  Tx tx(*this);
  for (auto statement : sql.split(';', Qt::SkipEmptyParts))
    if (!statement.trimmed().isEmpty())
      exec(statement);
  auto hasColumn = [&](const QString &table, const QString &column) {
    for (auto v : all("PRAGMA table_info(" + table + ")"))
      if (str(v.toObject(), "name") == column)
        return true;
    return false;
  };
  if (!hasColumn("sessions", "user_id")) {
    exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)");
    exec("DELETE FROM sessions");
  }
  if (!hasColumn("activity", "actor_id"))
    exec("ALTER TABLE activity ADD COLUMN actor_id TEXT");
  if (!hasColumn("activity", "actor_name"))
    exec("ALTER TABLE activity ADD COLUMN actor_name TEXT NOT NULL DEFAULT ''");
  if (one("SELECT id FROM users LIMIT 1").isEmpty() && !config("password").isEmpty()) {
    insert("users", {{"id", uid()},
                     {"username", "admin"},
                     {"name", "空间所有者"},
                     {"password", config("password")},
                     {"role", "owner"},
                     {"created_at", now()}});
  }
  exec("DELETE FROM config WHERE key='password'");
  initializeWiki(*this);
  initializePdf(*this);
  config("schema_version", "4");
  if (config("team_name").isEmpty())
    config("team_name", "我的学习空间");
  tx.commit();
  const auto keyPath = dataDir + "/.encryption-key";
  if (!QFile::exists(keyPath)) {
    writeFile(keyPath, QByteArray::fromHex(randomHex(32).toLatin1()));
    QFile::setPermissions(keyPath, QFile::ReadOwner | QFile::WriteOwner);
  }
  encryptionKey = readFile(keyPath);
  require(encryptionKey.size() == 32, 500, "加密密钥文件长度无效。");
}
Context::Context(const httplib::Request &r, httplib::Response &s) : req(r), res(s) {
  path = qs(r.path).split('/', Qt::SkipEmptyParts);
  if (!r.body.empty() &&
      r.get_header_value("Content-Type").find("application/json") != std::string::npos) {
    QJsonParseError error;
    auto doc = QJsonDocument::fromJson(QByteArray::fromStdString(r.body), &error);
    require(error.error == QJsonParseError::NoError && doc.isObject(), 400,
            "请求内容不是有效的 JSON 对象。");
    body = doc.object();
  }
}
void Context::json(Val v, int status) {
  res.status = status;
  res.set_content(bytes(pack(v)), "application/json; charset=utf-8");
}
bool Context::admin() const {
  return str(user, "role") == "owner" || str(user, "role") == "admin";
}
bool Context::editor() const {
  return admin() || str(user, "role") == "editor";
}
void Context::needAdmin() const {
  require(admin(), 403, "需要所有者或管理员权限。");
}
void Context::needEditor() const {
  require(editor(), 403, "只读成员没有编辑权限。");
}
Obj publicUser(Obj u) {
  u.remove("password");
  return u;
}
QString tokenFrom(const httplib::Request &req) {
  for (auto part : qs(req.get_header_value("Cookie")).split(';'))
    if (part.trimmed().startsWith("zhixu_session="))
      return part.trimmed().mid(14);
  return {};
}
Obj currentUser(Database &db, const httplib::Request &req) {
  auto token = tokenFrom(req);
  if (token.isEmpty())
    return {};
  return publicUser(db.one("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE "
                           "s.token=? AND s.expires>? AND u.active=1",
                           {digest(token), QDateTime::currentMSecsSinceEpoch()}));
}
void Context::session(const QString &userId) {
  db.exec("DELETE FROM sessions WHERE expires<?", {QDateTime::currentMSecsSinceEpoch()});
  auto token = randomHex(32);
  db.insert("sessions", {{"token", digest(token)},
                         {"expires", double(QDateTime::currentMSecsSinceEpoch() + 7LL * 86400000)},
                         {"user_id", userId}});
  bool secure =
      qgetenv("TRUST_PROXY") == "1" && req.get_header_value("X-Forwarded-Proto") == "https";
  res.set_header("Set-Cookie", bytes("zhixu_session=" + token +
                                     "; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800" +
                                     (secure ? "; Secure" : "")));
}
void validateSource(Database &db, const QString &source, const QString &chunk) {
  if (!source.isEmpty())
    db.must("sources", source);
  if (!chunk.isEmpty())
    require(!source.isEmpty() && str(db.must("chunks", chunk), "source_id") == source, 400,
            "来源片段与所选资料不匹配。");
}
QStringList tokens(const QString &input) {
  static QSet<QString> stop = {"的",   "了",     "是", "在",   "和",   "与",   "什么",
                               "如何", "为什么", "请", "解释", "一下", "这个", "the",
                               "is",   "of",     "to", "and",  "how",  "what"};
  QStringList result;
  auto matches = QRegularExpression("[a-z0-9_]{2,}|[\\p{Han}]+",
                                    QRegularExpression::UseUnicodePropertiesOption)
                     .globalMatch(input.toLower());
  while (matches.hasNext()) {
    auto word = matches.next().captured();
    if (stop.contains(word))
      continue;
    if (word[0].unicode() > 127) {
      for (qsizetype i = 0; i + 1 < word.size(); i++)
        if (!stop.contains(word.mid(i, 2)))
          result << word.mid(i, 2);
    } else
      result << word;
  }
  return result;
}
QStringList splitText(const QString &input, int size, int overlap) {
  auto clean = input;
  clean.remove(QChar(0));
  clean.replace("\r\n", "\n");
  clean = clean.trimmed();
  QStringList out;
  for (qsizetype start = 0; start < clean.size();) {
    auto end = std::min(start + size, clean.size());
    if (end < clean.size()) {
      auto boundary =
          std::max(clean.lastIndexOf('\n', end - 1), clean.lastIndexOf(QChar(0x3002), end - 1));
      if (boundary > start + size / 2)
        end = boundary + 1;
    }
    auto part = clean.mid(start, end - start).trimmed();
    if (!part.isEmpty())
      out << part;
    if (end == clean.size())
      break;
    start = std::max(start + 1, end - overlap);
  }
  return out;
}
Arr markdownChunks(const QString &input) {
  Arr out;
  QString heading = "正文", body;
  auto flush = [&]() {
    for (auto s : splitText(body))
      out.append(Obj{{"heading", heading}, {"content", s}, {"page", out.size() + 1}});
    body.clear();
  };
  for (auto line : QString(input).replace("\r\n", "\n").split('\n')) {
    auto m = QRegularExpression("^#{1,6}\\s+(.+)$").match(line);
    if (m.hasMatch()) {
      flush();
      heading = m.captured(1).trimmed();
    } else
      body += line + '\n';
  }
  flush();
  return out;
}
Arr rankChunks(const QString &question, const Arr &chunks, int limit) {
  auto qt = tokens(question);
  QSet<QString> queryTerms(qt.begin(), qt.end());
  if (queryTerms.isEmpty())
    return {};
  struct Doc {
    Obj row;
    QStringList words;
    double score = 0;
  };
  QList<Doc> docs;
  QMap<QString, int> df;
  double avg = 0;
  for (auto v : chunks) {
    auto c = v.toObject();
    auto w = tokens(str(c, "heading") + " " + str(c, "content"));
    avg += w.size();
    for (auto t : queryTerms)
      if (w.contains(t))
        df[t]++;
    docs.append({c, w, 0});
  }
  avg /= std::max(qsizetype(1), docs.size());
  for (auto &d : docs)
    for (auto t : queryTerms) {
      auto tf = d.words.count(t);
      if (!tf)
        continue;
      double idf = std::log(1 + (docs.size() - df[t] + 0.5) / (df[t] + 0.5));
      d.score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * d.words.size() / std::max(1.0, avg)));
      if (str(d.row, "heading").toLower().contains(t))
        d.score += idf * 0.5;
    }
  std::stable_sort(docs.begin(), docs.end(),
                   [](const auto &a, const auto &b) { return a.score > b.score; });
  Arr out;
  for (auto &d : docs)
    if (d.score > 0 && out.size() < limit) {
      d.row["score"] = d.score;
      out.append(d.row);
    }
  return out;
}
Obj modelSettings(Database &db) {
  auto base = db.config("model_base_url"), model = db.config("model_name");
  auto effort = db.config("model_reasoning_effort");
  return {{"baseUrl", base},
          {"model", model},
          {"reasoningEffort", effort.isEmpty() ? "default" : effort},
          {"pdfModel", db.config("pdf_model")},
          {"keyConfigured", !db.config("model_api_key").isEmpty()},
          {"configured", !base.isEmpty() && !model.isEmpty()}};
}
QString complete(Database &db, const Arr &messages, bool test, const CompletionOptions &options) {
  auto settings = modelSettings(db);
  require(settings["configured"].toBool(), 400, "请先在设置中配置模型地址与模型名称。");
  QNetworkAccessManager network;
  QNetworkRequest request(QUrl(str(settings, "baseUrl") + "/chat/completions"));
  request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                       QNetworkRequest::ManualRedirectPolicy);
  auto key = decrypt(db.config("model_api_key"));
  if (!key.isEmpty())
    request.setRawHeader("Authorization", ("Bearer " + key).toUtf8());
  auto effort = str(settings, "reasoningEffort");
  bool explicitEffort = effort != "default";
  Obj body{{"model", options.model.isEmpty() ? str(settings, "model") : options.model},
           {"messages", messages}};
  if (explicitEffort || options.document) {
    if (explicitEffort)
      body["reasoning_effort"] = effort;
    // Reasoning shares the completion budget; temperature is rejected by some models.
    body["max_completion_tokens"] = test ? 4096 : (explicitEffort ? 32768 : 8192);
  } else {
    body["temperature"] = 0.25;
    body["max_tokens"] = test ? 16 : 4000;
  }
  QJsonDocument doc;
  for (int attempt = 0; attempt < 2; ++attempt) {
    require(!options.canceled || !options.canceled(), 409, "解析已取消。");
    auto reply = network.post(request, pack(body).toUtf8());
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    QObject::connect(&timer, &QTimer::timeout, reply, &QNetworkReply::abort);
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QTimer cancellation;
    if (options.canceled) {
      QObject::connect(&cancellation, &QTimer::timeout, reply, [&] {
        try {
          if (options.canceled())
            reply->abort();
        } catch (...) {
          // Qt callbacks must not propagate database exceptions through the event loop.
          reply->abort();
        }
      });
      cancellation.start(500);
    }
    timer.start(explicitEffort || options.document ? (test ? 60000 : 180000)
                                                 : (test ? 20000 : 60000));
    loop.exec();
    auto status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    auto payload = reply->readAll();
    auto error = reply->error();
    reply->deleteLater();
    require(payload.size() <= 4 * 1024 * 1024, 502, "模型响应过大。");
    doc = QJsonDocument::fromJson(payload);
    if (status == 400 || status == 422) {
      auto upstream = doc.object()["error"].toObject();
      auto message = upstream["message"].toString().toLower();
      auto mentions = [&](const QString &parameter) {
        return upstream["param"].toString() == parameter || message.contains(parameter);
      };
      require(!explicitEffort || !mentions("reasoning_effort"), 502,
              "模型服务不接受所选推理强度，请选择该模型支持的强度，或改为“服务商默认”。");
      static const QRegularExpression unsupported(
          "unknown|unrecognized|unexpected|unsupported|not supported|not permitted|not allowed|不支持|未识别");
      auto code = upstream["code"].toString().toLower();
      // Retry only an explicitly unsupported token parameter, preserving the chosen effort.
      if ((explicitEffort || options.document) && attempt == 0 && mentions("max_completion_tokens") &&
          (unsupported.match(message).hasMatch() || code == "unsupported_parameter" ||
           code == "unknown_parameter")) {
        body["max_tokens"] = body.take("max_completion_tokens");
        continue;
      }
    }
    require(status >= 200 && status < 300, 502,
            status ? QString("模型服务返回 HTTP %1，请检查模型名称、密钥和服务额度。").arg(status)
                   : "无法连接模型服务或响应超时。");
    require(error == QNetworkReply::NoError, 502, "模型响应无效。");
    break;
  }
  auto choices = doc.object()["choices"].toArray();
  require(!choices.isEmpty(), 502, "模型服务未返回文本回答。");
  require(!options.document || str(choices[0].toObject(), "finish_reason") != "length", 502,
          "本页解析结果超出模型输出上限，请调整模型或降低推理强度后重试。");
  auto content = choices[0].toObject()["message"].toObject()["content"].toString().trimmed();
  require(!content.isEmpty() && content.size() <= 100000, 502, "模型服务未返回有效文本。");
  return content;
}
void selfTest() {
  require(tokens("二分查找 binary search").contains("二分"), 500, "中文分词失败");
  Arr c = {Obj{{"id", "a"}, {"heading", "二分查找"}, {"content", "有序序列与边界"}},
           Obj{{"id", "b"}, {"heading", "植物"}, {"content", "叶绿体"}}};
  require(str(rankChunks("二分查找", c)[0].toObject(), "id") == "a", 500, "检索失败");
  require(rankChunks("quasarflorp", c).isEmpty(), 500, "空检索失败");
  auto longText = QString("有序序列。每次缩小区间。\n").repeated(700) + "唯一尾部标记";
  auto parts = splitText(longText);
  require(parts.size() > 5 && parts.last().endsWith("唯一尾部标记"), 500, "切片失败");
  for (auto p : parts)
    require(p.size() <= 1100 && longText.contains(p), 500, "切片损坏");
  require(markdownChunks(" \n").isEmpty() && markdownChunks("# 标题\n正文内容").size() == 1, 500,
          "章节失败");
  require(calendarDate(QDateTime::fromString("2026-11-13T16:30:00Z", Qt::ISODate)) == "2026-11-14",
          500, "日期失败");
  auto h = hashPassword("test-password");
  require(verifyPassword("test-password", h) && !verifyPassword("bad", h), 500, "密码失败");
  std::cout << "C++ core tests passed\n";
}
