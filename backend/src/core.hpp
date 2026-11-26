#pragma once
#include "httplib.h"
#include <QtCore>
#include <QtNetwork>
#include <QtSql>
#include <functional>
#include <stdexcept>

using Obj = QJsonObject;
using Arr = QJsonArray;
using Val = QJsonValue;
struct Error : std::runtime_error {
  int status;
  Error(int s, const QString &m) : std::runtime_error(m.toStdString()), status(s) {}
};
inline void require(bool ok, int status, const QString &message) {
  if (!ok)
    throw Error(status, message);
}
inline QString str(const Obj &o, const char *key) {
  return o.value(key).toString();
}
inline std::string bytes(const QString &s) {
  return s.toUtf8().toStdString();
}
inline QString qs(const std::string &s) {
  return QString::fromUtf8(s.data(), qsizetype(s.size()));
}
QString uid();
QString now();
QString calendarDate(QDateTime at = QDateTime::currentDateTimeUtc());
QString text(const Obj &, const char *, int max = 30000, bool required = false,
             QString fallback = {});
QString ref(const Obj &, const char *);
QString date(const Obj &, const char *);
QString choice(const Obj &, const char *, const QStringList &, QString fallback = {});
Arr strings(const Obj &, const char *, int limit = 50);
QString pack(Val);
QByteArray readFile(const QString &);
void writeFile(const QString &, const QByteArray &);
QString hashPassword(const QString &);
bool verifyPassword(const QString &, const QString &);
QString randomHex(int size);
QString digest(const QString &);
QString encrypt(const QString &);
QString decrypt(const QString &);
extern QString dataDir;
extern const QStringList categories;

class Database {
  QString name;
  QSqlDatabase connection;

public:
  Database();
  ~Database();
  Database(const Database &) = delete;
  void exec(const QString &, const QVariantList &args = {});
  Arr all(const QString &, const QVariantList &args = {});
  Obj one(const QString &, const QVariantList &args = {});
  Obj must(const QString &table, const QString &id);
  Arr list(const QString &table);
  Obj decorate(const QString &table, Obj row);
  void insert(const QString &table, const Obj &row);
  void update(const QString &table, const QString &id, const Obj &row);
  QString config(const QString &);
  void config(const QString &, const QString &);
  void initialize();
  void activity(const Obj &user, const QString &kind, const QString &label);
  void checkVersion(const QString &table, const QString &id, const Obj &body);
  void bump(const QString &table, const QString &id);
};
class Tx {
  Database &db;
  bool done = false;

public:
  explicit Tx(Database &d) : db(d) { db.exec("BEGIN IMMEDIATE"); }
  void commit() {
    db.exec("COMMIT");
    done = true;
  }
  ~Tx() {
    if (!done)
      try {
        db.exec("ROLLBACK");
      } catch (...) {
      }
  }
};
struct Context {
  Database db;
  const httplib::Request &req;
  httplib::Response &res;
  Obj user, body;
  QStringList path;
  Context(const httplib::Request &r, httplib::Response &s);
  void json(Val value, int status = 200);
  bool method(const char *verb) const { return req.method == verb; }
  bool admin() const;
  bool editor() const;
  void needAdmin() const;
  void needEditor() const;
  void session(const QString &userId);
};
Obj publicUser(Obj);
Obj currentUser(Database &, const httplib::Request &);
QString tokenFrom(const httplib::Request &);
bool authRoutes(Context &);
bool teamRoutes(Context &);
bool collaborationRoutes(Context &);
bool learningRoutes(Context &);
bool uploadRoutes(Context &);
bool sourceManagementRoutes(Context &);
Obj sourceDeletionInfo(Database &, const QString &);
void deleteSourceRecord(Database &, const QString &, const Obj &user);
void deleteSourceFiles(const QString &);
bool researchRoutes(Context &);
bool wikiRoutes(Context &);
void initializeWiki(Database &);
void initializePdf(Database &);
struct PdfWorker {
  PdfWorker();
  ~PdfWorker();
};
Obj queuePdfParse(Database &, const QString &sourceId, const Obj &, const Obj &user);
Obj pdfParseDetail(Database &, const QString &sourceId);
bool pdfRoutes(Context &);
Arr wikiSearch(Database &, const QString &, int limit = 8, bool publishedOnly = false);
Arr retrieveEvidence(Database &, const QString &, const QString &source = {}, int limit = 6);
void validateSource(Database &, const QString &, const QString &chunk = {});
void ingest(Database &, const QString &, const Obj &user = {});
QStringList tokens(const QString &);
QStringList splitText(const QString &, int size = 1100, int overlap = 150);
Arr markdownChunks(const QString &);
Arr rankChunks(const QString &, const Arr &, int limit = 6);
Obj modelSettings(Database &);
struct TemporaryModelError : Error {
  explicit TemporaryModelError(const QString &message) : Error(502, message) {}
};
struct CompletionOptions {
  QString model;
  bool document = false;
  std::function<bool()> canceled;
  QString reasoningOverride;
};
QString complete(Database &, const Arr &, bool test = false, const CompletionOptions & = {});
void selfTest();
