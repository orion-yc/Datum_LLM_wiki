#include "core.hpp"
#include "projects.hpp"
#include "book_worker.hpp"
#include <csignal>
#include <iostream>

static httplib::Server *runningServer = nullptr;
static void shutdownServer(int) {
  if (runningServer)
    runningServer->stop();
}
int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  try {
    if (app.arguments().contains("--self-test")) {
      selfTest();
      return 0;
    }
    dataDir = QDir(qEnvironmentVariable("DATA_DIR", "data")).absolutePath();
    require(QDir().mkpath(dataDir + "/uploads"), 500, "无法创建数据目录。");
    {
      Database db;
      db.initialize();
      if (app.arguments().contains("--reset-owner-password")) {
        std::string input;
        std::getline(std::cin, input);
        auto pass = qs(input);
        require(pass.size() >= 8 && pass.size() <= 200, 400,
                "请从标准输入提供 8 至 200 个字符的新密码。");
        Tx tx(db);
        auto owner = db.one("SELECT id FROM users WHERE role='owner'");
        require(!owner.isEmpty(), 400, "空间尚未初始化。");
        db.update("users", str(owner, "id"), {{"password", hashPassword(pass)}});
        db.exec("DELETE FROM sessions");
        tx.commit();
        std::cout << "Owner password updated; all sessions revoked.\n";
        return 0;
      }
      for (auto s : db.all("SELECT id FROM sources WHERE status='processing'"))
        ingest(db, str(s.toObject(), "id"));
    }
    BookWorker bookWorker;
    PdfWorker pdfWorker;
    ProjectWorker projectWorker;
    httplib::Server server;
    server.new_task_queue = [] { return new httplib::ThreadPool(8, 32); };
    runningServer = &server;
    server.set_payload_max_length(155 * 1024 * 1024);
    server.set_read_timeout(30);
    server.set_write_timeout(120);
    server.set_keep_alive_max_count(50);
    const auto apiHandler = [](const httplib::Request &req, httplib::Response &res) {
      res.set_header("Cache-Control", "no-store");
      try {
        if (req.get_header_value("Content-Type").find("application/json") != std::string::npos)
          require(req.body.size() <= 1024 * 1024, 413, "请求内容不能超过 1 MB。");
        if (req.method != "GET" && req.method != "HEAD" && req.method != "OPTIONS") {
          auto origin = qs(req.get_header_value("Origin"));
          if (!origin.isEmpty()) {
            QUrl url(origin);
            require(url.isValid() && (url.scheme() == "http" || url.scheme() == "https") &&
                        url.authority() == qs(req.get_header_value("Host")),
                    403, "请求来源不匹配，请从当前网页重试。");
          } else
            require(req.get_header_value("Sec-Fetch-Site") != "cross-site", 403,
                    "不允许跨站请求。");
        }
        Context ctx(req, res);
        if (req.path == "/api/health" && req.method == "GET") {
          ctx.json(Obj{{"status", "ok"}, {"version", "0.3.0"}, {"backend", "C++20"}});
          return;
        }
        ctx.user = currentUser(ctx.db, req);
        if (authRoutes(ctx))
          return;
        require(!ctx.user.isEmpty(), 401, "请先登录。");
        // Authorize every mutating legacy endpoint on the server, before parsing or file writes.
        if (req.method != "GET" && req.method != "HEAD" && !qs(req.path).startsWith("/api/team") &&
            req.path != "/api/settings/password")
          ctx.needEditor();
        if (projectRoutes(ctx) || uploadRoutes(ctx) || teamRoutes(ctx) || collaborationRoutes(ctx) || researchRoutes(ctx) || wikiRoutes(ctx) ||
            pdfRoutes(ctx) || sourceManagementRoutes(ctx) || learningRoutes(ctx))
          return;
        throw Error(404, "接口不存在。");
      } catch (const Error &e) {
        res.status = e.status;
        if (e.status >= 500 && e.status != 502)
          std::cerr << "Request failed: " << e.what() << '\n';
        res.set_content(bytes(pack(Obj{{"error", e.status >= 500 && e.status != 502
                                                     ? QString("操作未完成，请稍后重试。")
                                                     : QString::fromUtf8(e.what())}})),
                        "application/json; charset=utf-8");
      } catch (const std::exception &e) {
        std::cerr << "Request failed: " << e.what() << '\n';
        res.status = 500;
        res.set_content("{\"error\":\"操作未完成，请稍后重试。\"}",
                        "application/json; charset=utf-8");
      }
    };
    server.Get("/api/.*", apiHandler);
    server.Post("/api/.*", apiHandler);
    server.Put("/api/.*", apiHandler);
    server.Patch("/api/.*", apiHandler);
    server.Delete("/api/.*", apiHandler);
    server.set_post_routing_handler([](const httplib::Request &, httplib::Response &res) {
      res.set_header("X-Content-Type-Options", "nosniff");
      res.set_header("X-Frame-Options", "SAMEORIGIN");
      res.set_header("Referrer-Policy", "same-origin");
      res.set_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      res.set_header("Content-Security-Policy",
                     "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                     "img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-src "
                     "'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'");
    });
    const auto dist = qEnvironmentVariable("STATIC_DIR", "dist");
    if (QFile::exists(dist + "/index.html"))
      server.set_mount_point("/", bytes(QDir(dist).absolutePath()));
    else
      server.Get("/", [](const auto &, auto &res) {
        res.set_content("请先运行 pnpm build，或在开发模式打开 http://localhost:5173。",
                        "text/plain; charset=utf-8");
      });
    std::signal(SIGINT, shutdownServer);
    std::signal(SIGTERM, shutdownServer);
    auto host = qEnvironmentVariable("HOST", "0.0.0.0");
    bool valid;
    auto port = qEnvironmentVariableIntValue("PORT", &valid);
    if (!valid)
      port = 3001;
    require(port > 0 && port <= 65535, 500, "PORT 无效。");
    std::cout << "Datum C++ server listening at http://" << bytes(host) << ":" << port << std::endl;
    require(server.listen(bytes(host), port), 500, "无法监听端口，请确认端口未被占用。");
    runningServer = nullptr;
  } catch (const std::exception &e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
  return 0;
}
