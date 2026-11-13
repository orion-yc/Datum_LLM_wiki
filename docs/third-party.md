# 第三方依赖

本仓库未替项目选择整体开源许可证。依赖保留各自许可证，分发时保留相应说明。

| 依赖 | 用途 | 来源 / 许可证 |
| --- | --- | --- |
| cpp-httplib v0.28.0 | C++ HTTP、multipart、静态文件 | `backend/third_party/httplib.h`，MIT，原文见 `httplib.LICENSE` |
| Qt 6 Core / Network / Sql | JSON、SQLite 驱动、HTTP 客户端、进程 | 系统动态库，Qt LGPLv3 / GPL / 商业条款以安装版本为准 |
| SQLite | 持久化与事务 | Qt QSQLITE 驱动，SQLite public domain |
| OpenSSL | scrypt、随机数、AES-GCM、恒定时间校验 | Linux 系统 OpenSSL 3，Apache-2.0；Windows 本机 1.1.1 遵循原版本条款 |
| Poppler / poppler-data | PDF 正文和 CJK 映射 | 独立 `pdftotext`；Poppler GPL-2.0-or-later，数据保留各自版权 |
| React / React DOM / lucide-react | 网页 | pnpm 固定版本，MIT / ISC |
| Vite / TypeScript / Playwright / pdf-lib | 构建和测试 | 开发依赖，保留各自许可证 |

cpp-httplib 头文件 SHA-256：`9e5cafaa227dad5c10e837990a736cecaff03258f50d37067cedeee1dba5d344`。更新需重新审阅来源和哈希。

生产 Docker 从 Debian 安装系统依赖，包保留 `/usr/share/doc/` 版权说明。Windows 测试使用本机 Qt MinGW 与独立 Poppler，`.tools/` 工具不提交仓库、不进入发布源码。
