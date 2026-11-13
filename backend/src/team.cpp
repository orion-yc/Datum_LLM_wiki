#include "core.hpp"
#include <mutex>

static QString password(const Obj &b) {
  auto p = b.value("password");
  require(p.isString() && p.toString().size() >= 8 && p.toString().size() <= 200, 400,
          "密码需要 8 至 200 个字符。");
  return p.toString();
}
static QString username(const Obj &b) {
  auto name = text(b, "username", 40, false, "admin").toLower();
  require(QRegularExpression("^[a-z0-9][a-z0-9_.-]{2,39}$").match(name).hasMatch(), 400,
          "账号需为 3–40 位字母、数字、点、下划线或短横线。");
  return name;
}
static void loginLimit(const httplib::Request &req) {
  static std::mutex mutex;
  static QMap<QString, QPair<int, qint64>> attempts;
  std::lock_guard lock(mutex);
  auto ip = qs(req.remote_addr);
  auto now = QDateTime::currentMSecsSinceEpoch();
  for (auto i = attempts.begin(); i != attempts.end();)
    if (i->second < now)
      i = attempts.erase(i);
    else
      ++i;
  auto &entry = attempts[ip];
  if (entry.second < now)
    entry = {0, now + 900000};
  require(entry.first < 30, 429, "尝试次数过多，请 15 分钟后重试。");
  entry.first++;
}
bool authRoutes(Context &c) {
  auto &db = c.db;
  auto p = qs(c.req.path);
  if (p == "/api/auth" && c.method("GET")) {
    c.json(Obj{{"initialized", !db.one("SELECT id FROM users LIMIT 1").isEmpty()},
               {"authenticated", !c.user.isEmpty()},
               {"user", c.user},
               {"teamName", db.config("team_name")}});
    return true;
  }
  if (p == "/api/auth/setup" && c.method("POST")) {
    loginLimit(c.req);
    auto pass = password(c.body);
    auto login = username(c.body);
    auto name = text(c.body, "name", 80, false, "空间所有者");
    auto team = text(c.body, "teamName", 80, false, "我的学习空间");
    Tx tx(db);
    require(db.one("SELECT id FROM users LIMIT 1").isEmpty(), 409, "已经完成初始化，请登录。");
    auto id = uid();
    db.insert("users", {{"id", id},
                        {"username", login},
                        {"name", name},
                        {"password", hashPassword(pass)},
                        {"role", "owner"},
                        {"created_at", now()}});
    db.config("team_name", team);
    c.session(id);
    tx.commit();
    c.json(Obj{{"ok", true}}, 201);
    return true;
  }
  if (p == "/api/auth/login" && c.method("POST")) {
    loginLimit(c.req);
    auto pass = password(c.body);
    auto user = db.one("SELECT * FROM users WHERE username=? AND active=1", {username(c.body)});
    require(!user.isEmpty() && verifyPassword(pass, str(user, "password")), 401,
            "账号或密码不正确。");
    c.session(str(user, "id"));
    c.json(Obj{{"ok", true}, {"user", publicUser(user)}});
    return true;
  }
  if (p == "/api/auth/logout" && c.method("POST")) {
    db.exec("DELETE FROM sessions WHERE token=?", {digest(tokenFrom(c.req))});
    c.res.set_header("Set-Cookie", "zhixu_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    c.json(Obj{{"ok", true}});
    return true;
  }
  if (p == "/api/auth/invitation" && c.method("GET")) {
    auto token = qs(c.req.get_param_value("token"));
    auto invite = db.one("SELECT role,expires FROM invitations WHERE token_hash=? AND revoked=0 "
                         "AND used_by IS NULL AND expires>?",
                         {digest(token), now()});
    require(!invite.isEmpty(), 404, "邀请不存在、已使用或已过期。");
    invite["teamName"] = db.config("team_name");
    c.json(invite);
    return true;
  }
  if (p == "/api/auth/join" && c.method("POST")) {
    loginLimit(c.req);
    auto token = text(c.body, "token", 100, true), login = username(c.body),
         name = text(c.body, "name", 80, true), hash = hashPassword(password(c.body));
    Tx tx(db);
    auto invite = db.one("SELECT * FROM invitations WHERE token_hash=? AND revoked=0 AND used_by "
                         "IS NULL AND expires>?",
                         {digest(token), now()});
    require(!invite.isEmpty(), 409, "邀请已失效，请联系管理员重新邀请。");
    require(db.one("SELECT id FROM users WHERE username=?", {login}).isEmpty(), 409,
            "这个账号已被使用。");
    auto id = uid();
    db.insert("users", {{"id", id},
                        {"username", login},
                        {"name", name},
                        {"password", hash},
                        {"role", invite["role"]},
                        {"created_at", now()}});
    db.update("invitations", str(invite, "id"), {{"used_by", id}});
    db.activity(Obj{{"id", id}, {"name", name}}, "team", "加入了团队");
    c.session(id);
    tx.commit();
    c.json(Obj{{"ok", true}}, 201);
    return true;
  }
  return false;
}
bool teamRoutes(Context &c) {
  auto &db = c.db;
  auto p = c.path;
  if (p.size() < 2 || p[1] != "team")
    return false;
  auto me = str(c.user, "id");
  if (p.size() == 2 && c.method("GET")) {
    Arr members;
    for (auto v :
         db.all("SELECT id,username,name,role,active,created_at FROM users ORDER BY created_at"))
      members.append(v);
    Obj result{{"name", db.config("team_name")}, {"members", members}, {"me", c.user}};
    if (c.admin())
      result["invitations"] = db.all(
          "SELECT i.id,i.role,i.expires,i.used_by,i.revoked,i.created_at,u.name created_by_name "
          "FROM invitations i JOIN users u ON u.id=i.created_by ORDER BY i.created_at DESC");
    c.json(result);
    return true;
  }
  if (p.size() == 2 && c.method("PUT")) {
    c.needAdmin();
    auto name = text(c.body, "name", 80, true);
    db.config("team_name", name);
    db.activity(c.user, "team", "修改了团队名称");
    c.json(Obj{{"ok", true}});
    return true;
  }
  if (p.size() == 3 && p[2] == "invitations" && c.method("POST")) {
    c.needAdmin();
    auto role = choice(c.body, "role",
                       str(c.user, "role") == "owner" ? QStringList{"admin", "editor", "viewer"}
                                                      : QStringList{"editor", "viewer"},
                       "editor");
    auto token = randomHex(32), id = uid(),
         expires = QDateTime::currentDateTimeUtc().addDays(7).toString(Qt::ISODateWithMs);
    db.insert("invitations", {{"id", id},
                              {"token_hash", digest(token)},
                              {"role", role},
                              {"created_by", me},
                              {"expires", expires},
                              {"created_at", now()}});
    db.activity(c.user, "team", "创建了成员邀请");
    c.json(Obj{{"id", id}, {"token", token}, {"role", role}, {"expires", expires}}, 201);
    return true;
  }
  if (p.size() == 4 && p[2] == "invitations" && c.method("DELETE")) {
    c.needAdmin();
    db.must("invitations", p[3]);
    db.update("invitations", p[3], {{"revoked", 1}});
    c.json(Obj{{"ok", true}});
    return true;
  }
  if (p.size() == 3 && p[2] == "profile" && c.method("PUT")) {
    db.update("users", me, {{"name", text(c.body, "name", 80, true)}});
    c.json(publicUser(db.must("users", me)));
    return true;
  }
  if (p.size() == 3 && p[2] == "owner" && c.method("POST")) {
    require(str(c.user, "role") == "owner", 403, "仅所有者可以转移空间。");
    auto target = ref(c.body, "user_id");
    require(!target.isEmpty() && target != me, 400, "请选择另一位成员。");
    Tx tx(db);
    auto owner = db.must("users", me), next = db.must("users", target);
    require(str(owner, "role") == "owner", 403, "空间所有者已变更，请刷新后重试。");
    require(verifyPassword(str(c.body, "password"), str(owner, "password")), 400,
            "当前密码不正确。");
    require(next["active"].toInt() == 1, 400, "新所有者必须是启用的成员。");
    db.update("users", me, {{"role", "admin"}});
    db.update("users", target, {{"role", "owner"}});
    db.activity(c.user, "team", "转移了空间所有权");
    tx.commit();
    c.json(Obj{{"ok", true}});
    return true;
  }
  if (p.size() >= 4 && p[2] == "members") {
    c.needAdmin();
    Tx tx(db);
    auto member = db.must("users", p[3]);
    require(str(member, "role") != "owner" && p[3] != me, 403, "不能修改所有者或自己的管理权限。");
    require(str(c.user, "role") == "owner" || str(member, "role") != "admin", 403,
            "只有所有者可以管理管理员。");
    if (p.size() == 4 && c.method("PATCH")) {
      Obj updates;
      if (c.body.contains("role"))
        updates["role"] =
            choice(c.body, "role",
                   str(c.user, "role") == "owner" ? QStringList{"admin", "editor", "viewer"}
                                                  : QStringList{"editor", "viewer"});
      if (c.body.contains("active")) {
        require(c.body["active"].isBool(), 400, "启用状态无效。");
        updates["active"] = c.body["active"].toBool() ? 1 : 0;
      }
      require(!updates.isEmpty(), 400, "没有要修改的成员信息。");
      db.update("users", p[3], updates);
      db.exec("DELETE FROM sessions WHERE user_id=?", {p[3]});
      db.activity(c.user, "team", "更新了成员「" + str(member, "name") + "」的权限或状态");
      tx.commit();
      c.json(publicUser(db.must("users", p[3])));
      return true;
    }
    if (p.size() == 5 && p[4] == "password" && c.method("POST")) {
      db.update("users", p[3], {{"password", hashPassword(password(c.body))}});
      db.exec("DELETE FROM sessions WHERE user_id=?", {p[3]});
      db.activity(c.user, "team", "重置了成员「" + str(member, "name") + "」的密码");
      tx.commit();
      c.json(Obj{{"ok", true}});
      return true;
    }
  }
  return false;
}
static QString targetTable(const QString &kind) {
  static const QMap<QString, QString> tables = {
      {"source", "sources"},         {"knowledge", "knowledge"}, {"plan", "plans"},
      {"comparison", "comparisons"}, {"paper", "papers"},        {"skill", "skills"},
      {"wiki", "wiki_pages"}};
  require(tables.contains(kind), 400, "无效的协作对象。");
  return tables[kind];
}
static void target(Database &db, const QString &kind, const QString &id) {
  db.must(targetTable(kind), id);
}
bool collaborationRoutes(Context &c) {
  auto p = c.path;
  auto &db = c.db;
  auto me = str(c.user, "id");
  if (p.size() < 2)
    return false;
  if (p[1] == "comments") {
    if (p.size() == 2 && c.method("GET")) {
      auto kind = qs(c.req.get_param_value("kind")), id = qs(c.req.get_param_value("target"));
      target(db, kind, id);
      c.json(db.all("SELECT c.*,u.name author_name FROM comments c JOIN users u ON "
                    "u.id=c.author_id WHERE kind=? AND target_id=? ORDER BY c.created_at",
                    {kind, id}));
      return true;
    }
    if (p.size() == 2 && c.method("POST")) {
      c.needEditor();
      auto kind = text(c.body, "kind", 30, true), id = ref(c.body, "target_id");
      target(db, kind, id);
      auto entity = uid(), stamp = now();
      db.insert("comments", {{"id", entity},
                             {"kind", kind},
                             {"target_id", id},
                             {"author_id", me},
                             {"content", text(c.body, "content", 10000, true)},
                             {"created_at", stamp},
                             {"updated_at", stamp}});
      db.activity(c.user, "comment", "添加了协作评论");
      c.json(db.must("comments", entity), 201);
      return true;
    }
    if (p.size() == 3) {
      auto row = db.must("comments", p[2]);
      c.needEditor();
      require(c.admin() || str(row, "author_id") == me, 403,
              "只能修改自己的评论，管理员可以处理全部评论。");
      if (c.method("PATCH")) {
        Obj update{{"updated_at", now()}};
        if (c.body.contains("content"))
          update["content"] = text(c.body, "content", 10000, true);
        if (c.body.contains("resolved")) {
          require(c.body["resolved"].isBool(), 400, "处理状态无效。");
          update["resolved"] = c.body["resolved"].toBool() ? 1 : 0;
        }
        db.update("comments", p[2], update);
        c.json(db.must("comments", p[2]));
        return true;
      }
      if (c.method("DELETE")) {
        db.exec("DELETE FROM comments WHERE id=?", {p[2]});
        c.json(Obj{{"ok", true}});
        return true;
      }
    }
  }
  if (p[1] == "tasks") {
    if (p.size() == 2 && c.method("GET")) {
      Arr tasks;
      for (auto v : db.all("SELECT t.*,a.name assignee_name,u.name created_by_name FROM tasks t "
                           "LEFT JOIN users a ON a.id=t.assignee_id JOIN users u ON "
                           "u.id=t.created_by ORDER BY t.created_at DESC"))
        tasks.append(db.decorate("tasks", v.toObject()));
      c.json(tasks);
      return true;
    }
    if (p.size() == 2 && c.method("POST")) {
      c.needEditor();
      auto kind = text(c.body, "kind", 30, true), id = ref(c.body, "target_id"),
           assignee = ref(c.body, "assignee_id");
      target(db, kind, id);
      if (!assignee.isEmpty()) {
        auto u = db.must("users", assignee);
        require(u["active"].toInt() == 1 && str(u, "role") != "viewer", 400,
                "任务负责人必须是启用的编辑者或管理员。");
      }
      auto entity = uid(), stamp = now();
      db.insert("tasks", {{"id", entity},
                          {"title", text(c.body, "title", 200, true)},
                          {"description", text(c.body, "description", 10000)},
                          {"kind", kind},
                          {"target_id", id},
                          {"assignee_id", assignee.isEmpty() ? Val(Val::Null) : Val(assignee)},
                          {"created_by", me},
                          {"due_date", date(c.body, "due_date")},
                          {"created_at", stamp},
                          {"updated_at", stamp}});
      db.activity(c.user, "task", "分配了任务「" + text(c.body, "title", 200, true) + "」");
      c.json(db.must("tasks", entity), 201);
      return true;
    }
    if (p.size() == 3) {
      c.needEditor();
      Tx tx(db);
      auto task = db.must("tasks", p[2]);
      require(c.admin() || str(task, "created_by") == me || str(task, "assignee_id") == me, 403,
              "只有创建者、负责人或管理员可以操作这项任务。");
      if (c.method("PATCH")) {
        db.checkVersion("tasks", p[2], c.body);
        Obj update{{"updated_at", now()}};
        if (c.body.contains("status"))
          update["status"] = choice(c.body, "status", {"todo", "doing", "done"});
        if (c.body.contains("assignee_id")) {
          require(c.admin() || str(task, "created_by") == me, 403,
                  "只有创建者或管理员可以重新分配任务。");
          auto id = ref(c.body, "assignee_id");
          if (!id.isEmpty()) {
            auto u = db.must("users", id);
            require(u["active"].toInt() == 1 && str(u, "role") != "viewer", 400,
                    "负责人无编辑权限。");
          }
          update["assignee_id"] = id.isEmpty() ? Val(Val::Null) : Val(id);
        }
        if (c.body.contains("title"))
          update["title"] = text(c.body, "title", 200, true);
        if (c.body.contains("description"))
          update["description"] = text(c.body, "description", 10000);
        if (c.body.contains("due_date"))
          update["due_date"] = date(c.body, "due_date");
        db.update("tasks", p[2], update);
        db.bump("tasks", p[2]);
        db.activity(c.user, "task", "更新了任务「" + str(task, "title") + "」");
        tx.commit();
        c.json(db.must("tasks", p[2]));
        return true;
      }
      if (c.method("DELETE")) {
        require(c.admin() || str(task, "created_by") == me, 403, "仅创建者或管理员可以删除任务。");
        db.exec("DELETE FROM tasks WHERE id=?", {p[2]});
        tx.commit();
        c.json(Obj{{"ok", true}});
        return true;
      }
    }
  }
  return false;
}
