# Twitter Automator

Twitter Automator 是一套面向 Twitter/X Timeline 数据采集的本地自动化工具，由浏览器扩展、Node.js 数据服务和管理页面组成。

浏览器扩展运行在已登录的 X 页面中，优先解析页面已经加载的 `UserTweets` 响应，并使用当前页面 DOM 作为兜底数据源。采集任务和结果通过本地 API 服务协调，管理页面用于创建任务和查看采集结果。

## 项目结构

```text
.
├─ plugins/
│  └─ timeline-collector/             # Chrome/Edge Manifest V3 扩展
└─ support/
   ├─ api/
   │  └─ twitter-timeline/            # Node.js 本地 API 与 SQLite 存储
   └─ admin/
      └─ twitter-timeline-admin/      # Vue 管理页面
```

`plugins/` 按“一个插件一个目录”组织，后续可以继续增加其他 Twitter/X 自动化插件；`support/` 集中放置数据服务、管理页面等辅助能力。

## 主要能力

- 在当前 X 账号页面中捕获并解析 Timeline 数据。
- 自动滚动页面，继续触发 Timeline 内容加载。
- 支持按时间范围和最大数量控制采集结果。
- 通过本地 SSE 通道把采集任务分发给浏览器扩展。
- 使用 SQLite 保存任务状态和采集结果。
- 通过管理页面创建任务、查看状态和查询推文。

## 环境要求

- Windows、macOS 或 Linux
- Node.js 22 或更高版本
- Chrome 或 Edge
- 浏览器已登录 Twitter/X

## 快速开始

### 1. 启动本地 API

在仓库根目录执行：

```powershell
$env:TWITTER_TIMELINE_HOST = "127.0.0.1"
$env:TWITTER_TIMELINE_DB_PATH = Join-Path $PWD "tmp\twitter-timeline.sqlite"

node .\support\api\twitter-timeline\server.js
```

默认服务地址为 `http://127.0.0.1:8001`。

### 2. 加载浏览器扩展

1. 打开 `chrome://extensions/` 或 `edge://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择仓库中的 `plugins/timeline-collector/` 目录。
5. 打开任意 X 账号页面，通过扩展图标打开 side panel。

### 3. 启动管理页面

```powershell
cd .\support\admin\twitter-timeline-admin
npm ci
npm run dev
```

Vite 会在终端输出管理页面的本地访问地址。

## 本地配置

API 服务支持以下环境变量：

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `TWITTER_TIMELINE_HOST` | API 监听地址 | `0.0.0.0` |
| `TWITTER_TIMELINE_PORT` | API 监听端口 | `8001` |
| `TWITTER_TIMELINE_API_TOKEN` | 管理 API 访问令牌 | `dev-twitter-timeline-api-token` |
| `TWITTER_TIMELINE_EXTENSION_TOKEN` | 扩展桥接令牌 | `dev-twitter-timeline-extension-token` |
| `TWITTER_TIMELINE_DB_PATH` | SQLite 数据库路径 | 本地 `tmp` 目录 |
| `TWITTER_TIMELINE_LOG_LEVEL` | 日志级别 | `info` |

默认令牌只用于本机开发。对局域网或公网开放服务前，必须通过环境变量替换令牌，并同步更新扩展的 `bridgeConfig` 和管理页面连接配置。

## 开发验证

```powershell
node .\plugins\timeline-collector\tests\content-script-merge.test.js
npm --prefix .\support\admin\twitter-timeline-admin run build
```

## 使用说明

- 本项目不会代替用户登录 Twitter/X，也不保存登录密码。
- 扩展主要处理当前页面已经加载的数据，不主动模拟未授权的 Twitter/X API 登录。
- 使用者应自行确认采集行为符合 Twitter/X 服务条款、适用法律和数据使用要求。
