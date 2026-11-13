# 服务器部署与维护

## 部署结构

浏览器通过域名访问 Nginx；Nginx 将网页与 `/api` 一并代理到 `127.0.0.1:3001`。同一个 Node.js 服务提供构建后的网页、API、资料文件和模型调用。SQLite 与上传文件保存在 `/app/data`，无需另装数据库。

## 环境参数

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `BIND_ADDRESS` | `127.0.0.1` | Compose 发布端口的宿主机地址 |
| `PORT` | `3001` | Compose 发布到宿主机的端口；直接运行时也是服务端口 |
| `DATA_VOLUME` | `zhixu-data` | Docker 数据卷名 |
| `TRUST_PROXY` | `0` | 同机可信反向代理为唯一入口时设为 `1` |
| `APP_TIMEZONE` | `Asia/Shanghai` | 服务端复习与待办使用的日历时区 |
| `HOST` | `0.0.0.0` | 直接运行 Node 时监听的地址 |
| `DATA_DIR` | `./data` | 直接运行 Node 时的数据目录；容器固定为 `/app/data` |

`.env` 由 Docker Compose 读取。直接运行 `node server/index.mjs` 时，需要通过 shell 环境设置参数，或使用 `node --env-file=.env server/index.mjs`；仅放置 `.env` 不会自动加载。

## 首次部署

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 app
```

先通过 SSH 隧道进入网页完成访问密码设置，然后启用域名的 HTTPS 访问。没有默认密码；第一个完成初始化的人建立这个个人空间。

Nginx 模板位于 `deploy/nginx.conf`。更改域名和上游端口；若宿主机端口不是 3001，需要相应修改 `proxy_pass`。模板的上传请求限制为 160 MB，覆盖单批 5 个 30 MB 文件。模型请求可能持续 60 秒，因此代理读取超时设置为 90 秒。

完成代理后设置 `TRUST_PROXY=1` 并重建容器配置。浏览器通过 HTTPS 访问时，登录 Cookie 将带 Secure 标记。代理需要保留 Host 和 X-Forwarded-Proto；Compose 默认不对公网发布 3001。

## 更新应用

1. 先备份数据。
2. 将新版项目文件同步到服务器。
3. 运行 `docker compose up -d --build`。
4. 查看 `docker compose ps` 与 `docker compose logs --tail=80 app`，打开网页检查资料与学习记录。

当前版本自动创建初始表结构，没有跨版本结构迁移系统；后续变更数据库字段时需要提供相应迁移脚本。不要用 `docker compose down -v` 作为日常更新命令，`-v` 会删除数据卷。

## 完整备份

网页导出适合阅读和携带学习记录。灾难恢复或完整迁移需要保留整个数据目录。

```bash
mkdir -p backups
docker compose stop app
docker compose cp app:/app/data ./backups/zhixu-data-backup
docker compose start app
```

每次使用一个新的备份目录名。数据目录包含：

- `knowledge.sqlite` 及可能存在的 `knowledge.sqlite-wal`、`knowledge.sqlite-shm`。
- `uploads/` 原始资料。
- `.encryption-key`，用于解密已保存的 API 密钥。

恢复到同一或新服务器时，先用相同版本启动一次容器并停止，再复制备份目录内容：

```bash
docker compose create app
docker compose cp ./backups/zhixu-data-backup/. app:/app/data
docker compose run --rm --user root app chown -R node:node /app/data
docker compose up -d
```

备份包含访问密码散列与会话信息。恢复后建议在网页中更新访问密码，从而使旧会话失效。缺少 `.encryption-key` 时，原有模型密钥无法解密，需要重新填写。

## 常见问题

**网页打不开**：先检查容器是否健康、宿主机的 3001 是否可访问，再检查域名代理和防火墙。默认端口只绑定本机，远程调试请使用 SSH 隧道。

**密码设置页面再次出现**：通常是连接了新的数据目录或数据卷。先核对 `DATA_VOLUME`、项目目录与挂载位置，保留原数据卷。

**PDF 解析失败**：查看资料页的错误说明。扫描件先做 OCR，加密 PDF 先移除密码保护。第一版不包含 OCR 服务。

**模型连接失败**：基础地址应包含 `/v1` 等服务要求的 API 前缀，但不包含 `/chat/completions`。核对模型名称、服务额度、密钥，以及容器到服务的网络。

**连接本地模型**：配置从容器可达的模型地址。Linux 下如需通过 `host.docker.internal` 访问宿主机，可在 Compose 服务下增加 `extra_hosts: ["host.docker.internal:host-gateway"]`，并确保模型服务监听容器可达的接口。

**上传请求被拒绝**：检查应用单文件 30 MB、每批 5 份限制以及代理的 `client_max_body_size`。

**忘记访问密码**：当前没有邮件找回流程。先停止服务并备份数据，使用 Node.js 的 SQLite 驱动或 SQLite 工具删除数据库 `config` 表中 `key='password'` 的记录，同时清空 `sessions` 表。随后仅通过受控连接重新设置密码，再恢复外部访问。不要删除整个数据库。

## 验证状态

交付时会在本机执行生产构建、API 集成测试和 Chromium 浏览器验收。Docker 文件需要在具备 Docker 的服务器上运行 `docker compose build` 与首次启动验收；本机环境未安装 Docker。
