# Twitter Automator

[English](README.md) | [简体中文](README.zh-CN.md)

Twitter Automator is a local Twitter/X Timeline collection system composed of a Manifest V3 browser extension, a Node.js data service, SQLite storage, and a Vue operations console.

The service persists target accounts, creates incremental jobs every day in Asia/Shanghai time, and dispatches them over SSE to a browser extension running in an authenticated X session. The console manages targets and schedules and shows each day's jobs and collected tweets.

## Project Structure

```text
plugins/timeline-collector/                 Chrome/Edge Manifest V3 extension
support/api/twitter-timeline/               Node.js API, daily scheduler, SQLite Store
support/admin/twitter-timeline-admin/       Green and white Vue operations console
tests/                                      Scheduler, Store, and API integration tests
```

## Features

- Persist username, display name, maximum tweets, and daily automation state.
- Configure one daily `HH:mm` trigger in fixed `Asia/Shanghai` time.
- Create daily incremental jobs for every enabled target.
- Collect the previous 24 hours on the first successful cycle, then continue from the last successful job's creation time.
- Run any target immediately.
- Filter historical jobs by execution date, account, status, and trigger type.
- Read each job's stored tweets in the console while retaining links to X.
- Store targets, settings, jobs, and tweets in SQLite behind a Store boundary that can later be implemented by an external database.

## Requirements

- Windows, macOS, or Linux
- Node.js 22 or later
- Chrome or Edge 116 or later
- An authenticated Twitter/X browser session

## Running the Project

All commands below run from the repository root: the directory containing the root `package.json`, `plugins/`, and `support/`. They can be used from PowerShell, Command Prompt, or another terminal.

### 1. Run the Local API

Working directory: repository root.

```powershell
npm start
```

The API listens at `http://127.0.0.1:8001`. Keep this terminal running.

### 2. Debug the Local API

Working directory: repository root. Node Inspector listens at `127.0.0.1:9228`.

```powershell
npm run start:debug
```

Attach the VS Code Node.js debugger or Chrome DevTools to port `9228`.

### 3. Install Console Dependencies

Run after the first checkout or whenever the lock file changes. This command still runs from the repository root:

```powershell
npm --prefix support/admin/twitter-timeline-admin ci
```

### 4. Run the Console in Development Mode

Open another PowerShell terminal. Working directory: repository root.

```powershell
npm run admin:dev
```

Open `http://127.0.0.1:17331`. Vite reloads the page when source files change.

### 5. Build and Preview the Console

Working directory: repository root.

```powershell
npm run admin:build
npm run admin:preview
```

The production build is written to `support/admin/twitter-timeline-admin/dist/`. Vite prints the preview URL in the terminal.

### 6. Load the Browser Extension

1. Keep the local API running.
2. Open `chrome://extensions/` or `edge://extensions/`.
3. Enable Developer mode and choose **Load unpacked**.
4. Select the repository's `plugins/timeline-collector` directory.
5. Open an X account page and click the extension icon to open the side panel.

## Console Workflow

1. Add a username, optional display name, and maximum tweet count under **Targets**.
2. Use the switch to include or exclude the target from daily automation.
3. Save the Asia/Shanghai trigger under **Daily Schedule**.
4. Use the play button to run one target immediately.
5. Filter **Daily History** by date and target, then open a job to read its saved tweets.

## Local Configuration

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `TWITTER_TIMELINE_HOST` | API listening address | `127.0.0.1` |
| `TWITTER_TIMELINE_PORT` | API listening port | `8001` |
| `TWITTER_TIMELINE_API_TOKEN` | Management API token | Development placeholder |
| `TWITTER_TIMELINE_EXTENSION_TOKEN` | Extension bridge token | Development placeholder |
| `TWITTER_TIMELINE_DB_PATH` | SQLite database path | `tmp/twitter-timeline.sqlite` |
| `TWITTER_TIMELINE_SCHEDULE_TIME` | Initial daily time for a new database | `09:00` |
| `TWITTER_TIMELINE_ADMIN_ORIGINS` | Allowed console origins | `127.0.0.1:17331,localhost:17331` |
| `TWITTER_TIMELINE_LOG_LEVEL` | Log level | `info` |

The environment schedule initializes only a new database. A schedule saved by the console remains authoritative after restarts.

New installations use `tmp/twitter-timeline.sqlite` inside the project. If that file does not exist but the legacy parent-workspace database does, the service continues to use the legacy path so existing jobs and tweets remain available.

Default tokens are for local development only. Replace them before listening beyond localhost and update the extension and console connection settings to match.

## Development Checks

Working directory: repository root.

```powershell
npm test
npm run check
npm run admin:build
```

## Usage Notes

- The project does not sign in to Twitter/X for the user and does not store passwords or cookies.
- The extension collects Timeline data from `UserTweets` responses already emitted by the page.
- Users must ensure collection complies with Twitter/X Terms of Service, applicable laws, and data-use requirements.
