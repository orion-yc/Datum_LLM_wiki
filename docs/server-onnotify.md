# datum-wiki.onnotify.top 服务器运维

本次部署采用 Ubuntu 24.04 原生 C++ 服务，用户为 `yangchen`，项目位于 `/home/yangchen/project/Datum_LLM_wiki`。前端构建产物在 `dist/`，后端在 `build/backend/datum-server`，构建和运行依赖在忽略的 `.tools/`。运行环境不依赖 Node.js。

2026-11-16 已更新到 `b308574` 并保留服务器的 250 MB 分块上传。该次更新的数据库模式为 4，升级前完整备份位于 `.tools/backups/before-b308574-20261116-182657/`；当前发布记录见 `.tools/current-deployment.json`。本地部署和上传改动尚未提交，上游更新前需保留并合并这些改动。

同日已发布本地整本 PDF 和续跑改动，当前数据库模式为 5，最近升级前备份为 `.tools/backups/before-long-pdf-b308574-20261116-210654/`。新任务支持暂停 / 继续和重启恢复，旧任务不自动重试。回退时恢复配对旧程序和完整数据目录；不能只换程序后继续使用已升级的数据库。

2026-11-17 发布跨任务增量复用、持久核查和目录去重，当前模式为 7；最近备份为 `.tools/backups/before-incremental-resume-b308574-20261117-113056/`。更新时使用临时 `datum_deploy_pause` 触发器等待当前页落盘后暂停，停止服务后已移除，更新后恢复任务；平时不应保留该触发器。解析旧任务续跑会合并已有结果，强制重做选择持久保存。

2026-11-18 发布上传超时恢复及 1–4 MiB 自适应分块，模式仍为 7，最新升级前备份为 `.tools/backups/before-upload-retry-b308574-20261118-111639/`。上传失败保留任务，有效期仍为一小时；当前文件选择不变时再次点击上传会续传。Caddy 配置维持原样。

同日发布公开 GitHub 项目学习，正式数据库模式为 8。升级前完整备份位于 `.tools/backups/before-project-learning-b308574-20261118-154540/`。切换前等待当前 PDF 页落盘，重启后队列从已有进度继续，维护触发器已移除。公网 HTTPS、静态资源及项目接口登录限制已核对；未修改 Caddy 或 DNS。

同日更新 GitHub 下载：优先读取固定提交的 ZIP，校验后再入库，遗漏文件仍可走逐文件下载。此次只替换后端，数据库模式仍为 8；发布前备份位于 `.tools/backups/before-project-archive-b308574-20261118-161046/`。原生运行使用 Ubuntu 自带的 libarchive 运行库，重新构建需 libarchive 开发包。

同日发布整仓大项目导入与项目删除。前后端均更新，数据库模式保持 8；发布前备份位于 `.tools/backups/before-project-scale-b308574-20261118-165541/`。导入会用 GitHub blob 接口补齐归档和原文地址均未能提供的文件。网络仍不可用的文件单列为待补齐，已完成的索引可阅读。

同日发布源码阅读工作台，提供目录树、Monaco 只读编辑器、Markdown、仓库图片和按需翻译。发布前备份位于 `.tools/backups/before-project-reader-b308574-20261118-180615/`。Monaco 使用发行包中的预编译资产，避免低内存服务器重新打包编辑器。图片缓存位于 `data/project-images/`，WebP 读取使用 Qt 图片格式插件。

## 域名与入口

- Cloudflare A 记录：`datum-wiki` → `8.163.3.67`。
- 公网入口由现有 `meeting-caddy.service` 提供，原 `video.onnotify.top` 站点保留。
- 现有 `/home/yangchen/project/Audio-Video_Server-go/bin/local/Caddyfile.public` 导入本项目的 `deploy/Caddyfile`。
- Caddy 自动申请和续期源站证书。使用 Cloudflare 代理时，SSL/TLS 应设为“完全（严格）”；证书验证受阻时先切换“仅 DNS”。
- 网页单文件上限 250 MB，大文件使用 8 MB 分块，Cloudflare 单次请求上限维持 100 MB 即可。临时上传写入 `data/upload-staging/`，过期任务在后续创建上传时清理。
- 后端只监听 `127.0.0.1:3001`，`TRUST_PROXY=1`。

## 账号与数据

已通过本机接口创建所有者 `admin`。随机初始密码保存在 `data/initial-owner.txt`，权限为 `0600`；此文件和整个 `data/` 均不纳入 Git。请私下读取该文件并保存到密码管理器。

数据库、上传文件和加密密钥均在 `data/`。备份必须包含整个目录，包括隐藏文件；建议停止服务后复制，完成后启动。不要删除 `.encryption-key`。

## 服务管理

用户服务文件安装到 `~/.config/systemd/user/datum-wiki.service`，并已启用 linger 和开机启动。

```bash
systemctl --user status datum-wiki.service
systemctl --user restart datum-wiki.service
journalctl --user -u datum-wiki.service -n 80 --no-pager
curl --fail http://127.0.0.1:3001/api/health
```

启动脚本 `deploy/run-native.sh` 设置 Qt 插件和本地库路径。不要直接执行二进制而遗漏这些环境变量。中文 PDF 还需系统路径 `/usr/share/poppler` 下的 `poppler-data`。

修改 Caddy 配置后：

```bash
/usr/local/bin/meeting-caddy validate --config /home/yangchen/project/Audio-Video_Server-go/bin/local/Caddyfile.public --adapter caddyfile
sudo systemctl restart meeting-caddy.service
```

现有 Caddy 2.6.2 配置关闭了管理 API，且不支持通过 SIGUSR1 重新加载。重启需要管理员权限，会短暂影响同进程的视频站点。原配置备份位于本项目 `.tools/backups/`。

## 原生构建

这台约 1.6 GiB、无 swap 的服务器使用系统级资源限制构建：

```bash
sh deploy/build-limited.sh
sh deploy/test-limited.sh
```

脚本通过用户级 systemd 临时服务设置 `MemoryMax=650M`、`MemorySwapMax=0`、`CPUQuota=60%`、`OOMPolicy=kill`。后端只开一个编译进程，GCC 使用 `-O1` 并调低编译器垃圾回收阈值；后端、TypeScript 检查和网页构建顺序执行。Node.js 堆上限 320 MB。若超过资源上限，构建任务失败，正式服务保留原产物。

新产物分别写入 `build/upload-release/datum-server` 和 `build/upload-web/`。不要在服务器上同时运行前后端构建或直接覆盖运行中的二进制。验证后停止服务、备份整个 `data/` 和旧产物，再替换并启动。仓库通用构建命令供资源充足的开发机 / CI 使用。

```bash
systemctl --user list-units 'datum-build-*'
systemctl --user show <构建服务名> -p MemoryCurrent -p MemoryPeak -p MemoryMax
```
