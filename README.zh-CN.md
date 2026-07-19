# Twitter Automator

[English](README.md) | [简体中文](README.zh-CN.md)

Twitter Automator 是一套本地 Twitter/X Timeline 自动采集工具，由 Manifest V3 浏览器插件、Node.js 数据服务、SQLite 数据库和 Vue 管理台组成。

服务端可以保存目标账号、每天按北京时间自动创建增量采集任务，并通过 SSE 将任务下发给已经登录 X 的浏览器插件。管理台用于维护账号、设置触发时间，以及按日期查看任务和当次 tweets。

## 项目结构

```text
plugins/timeline-collector/                 Chrome/Edge Manifest V3 插件
support/api/twitter-timeline/               Node.js API、每日调度和 SQLite Store
support/admin/twitter-timeline-admin/       黑白风格 Vue 管理台
tests/                                      调度、Store 和 API 集成测试
```

## 主要能力

- 保存用户名、显示名称、单次最大 tweets 和每日自动执行状态。
- 设置一个 `HH:mm` 每日触发时间，时区固定为 `Asia/Shanghai`。
- 为所有已启用账号创建每日增量任务。
- 没有成功历史时采集过去 24 小时；以后从上次成功任务创建时间继续。
- 支持单个目标立即运行。
- 按执行日期、账号、状态和触发类型查询历史任务。
- 在管理台内查看每次任务保存的 tweets，并保留 X 原文链接。
- 使用 SQLite 保存目标、设置、任务和 tweets；未来可替换 Store 接入外部数据库。

## 环境要求

- Windows、macOS 或 Linux
- Node.js 22 或更高版本
- Chrome 或 Edge 116 或更高版本
- 浏览器已经登录 Twitter/X

## 启动项目

以下命令默认在仓库根目录执行。仓库根目录是包含根 `package.json`、`plugins/` 和 `support/` 的目录，可在 PowerShell、命令提示符或其他终端中运行。

### 1. 终端运行本地 API

执行目录：仓库根目录。

```powershell
npm start
```

API 地址为 `http://127.0.0.1:8001`。该终端需要保持运行。

### 2. 调试本地 API

执行目录：仓库根目录。Node Inspector 使用 `127.0.0.1:9228`。

```powershell
npm run start:debug
```

可使用 VS Code Node.js 调试器或 Chrome DevTools 附加到 `9228`。

### 3. 安装管理台依赖

首次运行或锁文件变化后执行。以下命令仍在仓库根目录运行：

```powershell
npm --prefix support/admin/twitter-timeline-admin ci
```

### 4. 开发模式运行管理台

另开一个 PowerShell 终端。执行目录：仓库根目录。

```powershell
npm run admin:dev
```

管理台地址为 `http://127.0.0.1:17331`，Vite 会监听源码变化并刷新页面。

### 5. 构建和预览管理台

执行目录：仓库根目录。

```powershell
npm run admin:build
npm run admin:preview
```

生产构建输出到 `support/admin/twitter-timeline-admin/dist/`。Vite 会在终端显示预览地址。

### 6. 加载浏览器插件

1. 保持本地 API 运行。
2. 打开 `chrome://extensions/` 或 `edge://extensions/`。
3. 开启开发者模式，选择“加载已解压的扩展程序”。
4. 选择仓库中的 `plugins/timeline-collector` 目录。
5. 打开任意 X 账号页面，通过扩展图标打开 side panel。

## 管理台工作流

1. 在“目标账号”区域添加用户名、显示名称和最大 tweets。
2. 使用开关决定该账号是否参加每日自动执行。
3. 在“每日调度”中保存北京时间触发时间。
4. 使用播放按钮可以立即为单个账号创建任务。
5. 在“每日任务数据”中选择日期和账号，点击查看当次保存的 tweets。

## 本地配置

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `TWITTER_TIMELINE_HOST` | API 监听地址 | `127.0.0.1` |
| `TWITTER_TIMELINE_PORT` | API 监听端口 | `8001` |
| `TWITTER_TIMELINE_API_TOKEN` | 管理 API Token | 开发占位符 |
| `TWITTER_TIMELINE_EXTENSION_TOKEN` | 插件桥接 Token | 开发占位符 |
| `TWITTER_TIMELINE_DB_PATH` | SQLite 数据库路径 | `tmp/twitter-timeline.sqlite` |
| `TWITTER_TIMELINE_SCHEDULE_TIME` | 新数据库的初始每日时间 | `09:00` |
| `TWITTER_TIMELINE_ADMIN_ORIGINS` | 允许的管理台 Origin | `127.0.0.1:17331,localhost:17331` |
| `TWITTER_TIMELINE_LOG_LEVEL` | 日志级别 | `info` |

环境变量中的调度时间只用于初始化新数据库。管理台保存的设置会在后续重启时继续生效。

新安装默认使用项目内的 `tmp/twitter-timeline.sqlite`。如果项目内还没有数据库、但检测到旧版本曾使用的父工作区数据库，服务会继续使用旧路径，避免已有任务和 tweets 丢失。

默认 Token 仅用于本机开发。对局域网或公网开放前必须替换 Token，并同步更新插件和管理台连接设置。

## 开发验证

执行目录：仓库根目录。

```powershell
npm test
npm run check
npm run admin:build
```

## 使用说明

- 项目不会代替用户登录 Twitter/X，也不保存登录密码或 Cookie。
- 插件通过页面已经发出的 `UserTweets` 响应采集 Timeline 数据。
- 使用者应确保采集行为符合 Twitter/X 服务条款、适用法律和数据使用要求。
