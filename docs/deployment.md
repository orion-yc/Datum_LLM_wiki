# C++ 服务器部署与维护

## 服务结构与参数

浏览器 → HTTPS / Nginx → `datum-server` C++20 → SQLite / 上传文件 / Poppler。使用 Qt Core、Network、Sql，OpenSSL 和 cpp-httplib；网页来自 React 构建产物。运行环境不依赖 Node.js。

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `BIND_ADDRESS` | `127.0.0.1` | Compose 宿主机监听地址 |
| `PORT` | `3001` | 宿主机映射端口；原生启动时为监听端口 |
| `DATA_VOLUME` | `zhixu-data` | 升级时保留原数据卷名称 |
| `TRUST_PROXY` | `0` | 唯一入口为可信反向代理时设为 `1` |
| `APP_TIMEZONE` | `Asia/Shanghai` | 复习日历时区 |
| `HOST` | `0.0.0.0` | 原生监听地址 |
| `DATA_DIR` | `./data` | 容器内为 `/app/data` |
| `STATIC_DIR` | `./dist` | 容器内为 `/app/dist` |
| `PDFTOTEXT` | `pdftotext` | Poppler 程序路径；不拼接 shell |
| `PDFINFO` | 自动发现 | AI 解析页数工具；优先使用 `PDFTOTEXT` 同目录程序，否则使用 PATH |
| `PDFTOPPM` | 自动发现 | AI 解析逐页渲染工具；可指定绝对路径 |

`.env` 由 Compose 读取，原生运行需自行设置环境。

## 首次部署

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 app
```

默认仅本机能访问 3001。先用 SSH 隧道创建所有者账号、显示姓名、空间名和密码，再配置 HTTPS。无默认密码。团队页面生成单次邀请，受邀者自行设置独立密码。

修改 `deploy/nginx.conf` 的域名、证书和上游端口。模板允许 160 MB 请求，应用每份 30 MB、每批 5 份。论文生成最多逐篇调用 8 次模型，每次默认最长 60 秒，显式推理强度时最长 180 秒；按实际模型速度调整代理读取超时。普通 PDF 解析最长 120 秒。AI PDF 解析通过后台队列逐页执行，不占用长时间的网页请求。

可信代理为唯一入口时设置 `TRUST_PROXY=1`，传入 `X-Forwarded-Proto: https` 后 Cookie 附带 Secure。代理保留 Host，应用检验写请求 Origin。

容器以 UID / GID 1000 的 `datum` 运行，沿用旧镜像 UID。运行容器只读，数据库、密钥和文件写入挂载卷。

## 旧版升级与回退

1. 停止旧服务并完整备份。
2. 更新代码，保留 `.env`、`DATA_VOLUME` 和挂载位置。
3. 执行 `docker compose up -d --build`。
4. 用 **admin** 与旧访问密码登录，核对资料和模型设置。

首次迁移在 `data/backups/` 建立 `before-cpp-*.sqlite` 和配对 `.key`；迁移在事务内执行，重启不重复。原始文件不移动，旧会话失效，密码散列和 AES-GCM 格式兼容。

从 v0.2 C++ 版本升级到 v0.3 时同样备份；已有成员与会话保留，模式升到 3，增加 Wiki 页面、证据、链接和历史表，并为旧上传文件补建内容指纹。备份沿用上述文件名前缀。指纹回填期间启动可能稍慢，不会调用模型或修改原文内容。

本次 AI PDF 功能将模式从 3 升到 4，先备份再增加任务、页面及片段版本字段。AI 结果只有网页核对采用后才更新当前页面；历史片段继续支撑已有引用。服务重启不自动重试付费请求，中断任务标为失败，保留已完成页面，用户可在网页重新发起。

回退时停止 C++ 服务，恢复完整升级前备份，再启动旧镜像。不要让两个版本同时访问同一目录，不要用会删除数据卷的 `docker compose down -v` 更新。

## 备份与恢复

管理员网页 JSON 导出包含学习记录、Wiki 页面和关系、论文、版本、讨论、任务和成员公开信息，不含密码、会话、邀请令牌、模型密钥或原始文件。

完整恢复需保留整个目录：

```bash
docker compose stop app
docker compose cp app:/app/data ./datum-data-backup
docker compose start app
```

每次使用新的备份名。包括数据库及 WAL / SHM、`uploads/`、`pdf-previews/`、`.encryption-key`、`backups/`。没有原密钥无法解密原模型密钥。`pdf-previews/` 保存每份 PDF 最近一次解析的页面图片，便于电脑和手机直接对照；下一次解析会清理旧图片，删除资料时同时删除缓存，不影响原始 PDF 和历史文本引用。

恢复到已创建数据卷：

```bash
docker compose create app
docker compose cp ./datum-data-backup/. app:/app/data
docker compose run --rm --user root app chown -R datum:datum /app/data
docker compose up -d
```

## 密码恢复

普通成员由管理员在网页重置。所有者遗失密码且无人可管理时，在服务器终端恢复；新密码从标准输入读取，不进入命令行参数。先备份。

```bash
docker compose stop app
read -s -r -p 'New owner password: ' DATUM_NEW_PASSWORD
printf '\n'
printf '%s\n' "$DATUM_NEW_PASSWORD" | docker compose run --rm -T app /app/datum-server --reset-owner-password
unset DATUM_NEW_PASSWORD
docker compose up -d
```

此命令重置当前所有者密码并撤销全部会话，保留资料。不要删除用户表或数据库重置密码。

## 排查

- **资料为空**：核对卷名、数据目录和挂载位置，可能连接了新目录。
- **PDF 失败**：检查扫描件、密码保护或损坏；原生运行需确保 `pdftotext`、`poppler-data` 可用。扫描页可使用阅读页的 AI 解析；需 `pdfinfo`、`pdftoppm` 和支持图片输入的模型，普通文本连接测试成功不代表模型具备视觉能力。
- **AI PDF 未完成**：在阅读页查看进度与错误，缩小页面范围检查服务商的图片输入和输出预算限制。每次最多 50 页，全实例串行运行，最多排队 12 个任务；取消会中止正在等待的模型请求。关闭浏览器不会取消后台任务，服务重启后需重新发起。模型失败不会覆盖已采用正文。
- **模型失败**：地址包含 `/v1` 等服务前缀，不包含 `/chat/completions`；核对模型 ID、密钥、额度和网络。容器内连接宿主机模型需使用容器可达地址。
- **版本冲突**：保留需要的输入，读取最新版本再合并。旧版本保存不会覆盖新内容。
- **发布拒绝**：检查指定审核人、每格证据、综合结论、未解决评论及工作流状态。
- **Wiki 发布拒绝**：补充正文和原文证据，修正 `[n]` 编号，解决关联讨论。已发布页面需由管理员转回草稿后编辑。
- **重复上传**：内容指纹与已有文件一致时本批次整体不导入，请在资料库查找已有资料；解析失败可使用原条目的重试入口。

本机完成 Windows 原生 C++ 编译运行验收。Docker 本机不可用；服务器首次部署需验证镜像构建、健康检查、数据卷持久化与 HTTPS。

低内存服务器建议在有足够内存的构建机生成产物或镜像后再部署，避免同时运行 C++ 优化编译、前端类型检查和现有服务。AI 解析本身逐页渲染、串行请求，无需在服务器加载模型或 OCR 框架；仍应从少量页面开始观察实际内存和耗时。
