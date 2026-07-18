# Twitter Automator

English | [简体中文](README.zh-CN.md)

Twitter Automator is a local automation toolkit for collecting Twitter/X Timeline data. It consists of a browser extension, a Node.js data service, and an administration interface.

The browser extension runs on an authenticated X page. It prioritizes parsing `UserTweets` responses already loaded by the page and uses the current page DOM as a fallback data source. The local API service coordinates collection jobs and results, while the administration interface creates jobs and displays collected data.

## Project Structure

```text
.
├─ plugins/
│  └─ timeline-collector/             # Chrome/Edge Manifest V3 extension
└─ support/
   ├─ api/
   │  └─ twitter-timeline/            # Node.js local API and SQLite storage
   └─ admin/
      └─ twitter-timeline-admin/      # Vue administration interface
```

`plugins/` follows a one-directory-per-plugin convention, allowing additional Twitter/X automation plugins to be added later. `support/` contains supporting services and administration interfaces.

## Features

- Captures and parses Timeline data from the current X account page.
- Automatically scrolls the page to trigger additional Timeline loading.
- Limits collection results by time range and maximum item count.
- Dispatches collection jobs to the browser extension over a local SSE channel.
- Stores job state and collected results in SQLite.
- Provides an administration interface for creating jobs, monitoring status, and querying posts.

## Requirements

- Windows, macOS, or Linux
- Node.js 22 or later
- Chrome or Edge
- An authenticated Twitter/X browser session

## Quick Start

### 1. Start the Local API

Run the following commands from the repository root:

```powershell
$env:TWITTER_TIMELINE_HOST = "127.0.0.1"
$env:TWITTER_TIMELINE_DB_PATH = Join-Path $PWD "tmp\twitter-timeline.sqlite"

node .\support\api\twitter-timeline\server.js
```

The default service URL is `http://127.0.0.1:8001`.

### 2. Load the Browser Extension

1. Open `chrome://extensions/` or `edge://extensions/`.
2. Enable Developer mode.
3. Select **Load unpacked**.
4. Choose the `plugins/timeline-collector/` directory in this repository.
5. Open any X account page and click the extension icon to open the side panel.

### 3. Start the Administration Interface

```powershell
cd .\support\admin\twitter-timeline-admin
npm ci
npm run dev
```

Vite will print the local administration URL in the terminal.

## Local Configuration

The API service supports the following environment variables:

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `TWITTER_TIMELINE_HOST` | API listening address | `0.0.0.0` |
| `TWITTER_TIMELINE_PORT` | API listening port | `8001` |
| `TWITTER_TIMELINE_API_TOKEN` | Administration API access token | `dev-twitter-timeline-api-token` |
| `TWITTER_TIMELINE_EXTENSION_TOKEN` | Extension bridge token | `dev-twitter-timeline-extension-token` |
| `TWITTER_TIMELINE_DB_PATH` | SQLite database path | Local `tmp` directory |
| `TWITTER_TIMELINE_LOG_LEVEL` | Logging level | `info` |

The default tokens are intended for local development only. Before exposing the service to a LAN or the public internet, replace both tokens through environment variables and update the extension `bridgeConfig` and administration connection settings accordingly.

## Development Checks

```powershell
node .\plugins\timeline-collector\tests\content-script-merge.test.js
npm --prefix .\support\admin\twitter-timeline-admin run build
```

## Usage Notes

- This project does not sign in to Twitter/X on behalf of the user and does not store login passwords.
- The extension primarily processes data already loaded by the current page and does not simulate unauthorized Twitter/X API authentication.
- Users are responsible for ensuring that their collection activities comply with the Twitter/X Terms of Service, applicable laws, and data-use requirements.
