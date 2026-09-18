# Netprobe Desktop

[![Desktop CI](https://github.com/UmaisNisar/netprobe_lite/actions/workflows/desktop-ci.yml/badge.svg)](https://github.com/UmaisNisar/netprobe_lite/actions/workflows/desktop-ci.yml)
[![Latest release](https://img.shields.io/github/v/release/UmaisNisar/netprobe_lite?filter=desktop-v*&label=release)](https://github.com/UmaisNisar/netprobe_lite/releases/latest)

**Monitor your home internet quality from the system tray. No Docker, no Grafana, no config files.**

Netprobe checks your connection every 30 seconds for **latency, packet loss, jitter and DNS response time**, runs optional **bandwidth tests**, and rolls it all into a single **Internet Quality Score**. Download it, install it, and it starts recording. When your ISP says "everything looks fine on our end", you have 30 days of history to show them.

This is a desktop port of [plaintextpackets/netprobe_lite](https://github.com/plaintextpackets/netprobe_lite). The original runs as six Docker containers (Python probes, Redis, Prometheus and Grafana). This version does the same job in one app.

![Netprobe dashboard](docs/screenshot-top.png)

![Netprobe history charts](docs/screenshot-charts.png)

## Download

| Platform | File |
|---|---|
| **Windows** 10/11 (installer) | [Netprobe-Setup.exe](https://github.com/UmaisNisar/netprobe_lite/releases/latest/download/Netprobe-Setup.exe) |
| **Windows** (portable, no install) | [Netprobe-Portable.exe](https://github.com/UmaisNisar/netprobe_lite/releases/latest/download/Netprobe-Portable.exe) |
| **macOS**, Apple Silicon (M1–M4) | [Netprobe-mac-arm64.dmg](https://github.com/UmaisNisar/netprobe_lite/releases/latest/download/Netprobe-mac-arm64.dmg) |
| **macOS**, Intel | [Netprobe-mac-x64.dmg](https://github.com/UmaisNisar/netprobe_lite/releases/latest/download/Netprobe-mac-x64.dmg) |
| **Linux** (AppImage) | [Netprobe-linux.AppImage](https://github.com/UmaisNisar/netprobe_lite/releases/latest/download/Netprobe-linux.AppImage) |

All releases: [github.com/UmaisNisar/netprobe_lite/releases](https://github.com/UmaisNisar/netprobe_lite/releases)

### First launch: security warnings

The builds are not code-signed (signing certificates cost money), so your OS will warn you the first time you open the app:

- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**.
- **macOS:** You may see "Netprobe can't be opened" or "is damaged". Open **System Settings → Privacy & Security** and click **Open Anyway**, or run this once in Terminal:
  ```sh
  xattr -dr com.apple.quarantine /Applications/Netprobe.app
  ```
- **Linux:** make the file executable first: `chmod +x Netprobe-linux.AppImage`.

## Features

- **Runs in the tray.** Closing the window keeps monitoring. The tray icon turns green, amber or red with your score, and hovering it shows the current numbers.
- **Starts at login** (optional, on by default) so history builds up without you thinking about it.
- **Live dashboard:** a score gauge, current latency, loss, jitter, DNS and bandwidth, plus a per-site and per-DNS-server breakdown of the latest probe.
- **History charts** for 1h, 6h, 24h, 7d or 30d, with synced crosshairs across all charts. Gaps show when the PC was off rather than drawing misleading lines.
- **Settings in the app:** sites, DNS servers, probe interval, score weights, thresholds, speed test and retention. No `.env` editing.
- **Detects your home DNS server** automatically on first run.
- **Local only.** Data stays in a SQLite file on your machine. No accounts, no telemetry, no open ports.
- **No admin rights needed.** It uses your OS's built-in `ping`.

## What it measures

Every probe (default: every 30 s):

| Metric | How |
|---|---|
| **Latency** | Average round-trip time of 50 pings to each site (default: google.com, facebook.com, twitter.com, youtube.com, cloudflare.com) |
| **Packet loss** | Percentage of those pings that got no reply |
| **Jitter** | Mean difference between consecutive ping times (RFC 3550 style) |
| **DNS response time** | Time to resolve `google.com` against Google (8.8.8.8), Quad9 (9.9.9.9), Cloudflare (1.1.1.1) and **your own DNS server**. A failed lookup counts as 5000 ms |
| **Bandwidth** *(optional, off by default)* | Download and upload throughput against `speed.cloudflare.com`, using 4 parallel streams for 8 seconds each way (capped at 500 MB per direction) |

### Internet Quality Score

It's the same formula as the original. Each metric is compared to its threshold (capped at 100%), and the weighted results are subtracted from 1:

```
score = 1 − 0.60 × min(loss / 5%, 1)
          − 0.15 × min(latency / 100 ms, 1)
          − 0.20 × min(jitter / 30 ms, 1)
          − 0.05 × min(my DNS / 100 ms, 1)
```

**100%** is perfect. Packet loss dominates because it's what actually breaks calls and games. Weights and thresholds can be changed in Settings.

## Getting accurate results

- **Use a wired connection if you can.** On Wi-Fi you're measuring your Wi-Fi *plus* your ISP. That's still useful, but a spike might be the microwave rather than your provider. For the cleanest ISP data, run it on a PC connected to your router by Ethernet.
- **Leave it running.** Netprobe only records while your computer is on. For 24/7 coverage, run it on an always-on machine, or use the [original Docker version](docs/DOCKER.md) on a home server.
- **Some sites ignore ping.** amazon.com and netflix.com, for example, block ICMP. A site that answers no pings while others do is marked **no reply** and left out of the score. If *every* site goes silent, that's an outage and counts as 100% loss.
- **Speed tests use data.** A test uses about 200 MB on a 100 Mbps line and at most ~1 GB on gigabit+. At the default ~15-minute interval that adds up, so leave it off on metered or mobile connections, or raise the interval.

## Settings

Click **Settings** in the top-right corner of the dashboard.

| Setting | Default | Notes |
|---|---|---|
| Sites to ping | 5 popular sites | One domain per line, up to 20 |
| Probe interval | 30 s | 15 s to 1 h |
| Pings per site | 50 | Sent over 5 parallel streams, so a probe takes about 10 s |
| DNS test domain | google.com | |
| DNS servers | Google, Quad9, Cloudflare, *your router* | Mark the one your network uses as **mine**; it feeds the score |
| Speed test | Off | Interval in minutes (default ~15) |
| Score weights / thresholds | 0.6 / 0.15 / 0.2 / 0.05 and 5% / 100 / 30 / 100 ms | Weights should add up to 1.0 |
| Start at login | On | Starts hidden in the tray |
| Keep history for | 30 days | Older data is deleted automatically |

The tray menu also has **Probe now**, **Run speed test now**, **Pause monitoring** and **Quit**.

### Where data is stored

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Netprobe` |
| macOS | `~/Library/Application Support/Netprobe` |
| Linux | `~/.config/Netprobe` |

It contains `settings.json` and `netprobe.db` (SQLite). Delete the folder to reset everything, or use **Settings → Clear all history**.

## How it differs from the Docker version

| | netprobe_lite (Docker) | Netprobe Desktop |
|---|---|---|
| Install | Docker + `docker compose up` | Download and run an installer |
| Components | 6 containers: Python probe, speed test, Redis, exporter, Prometheus, Grafana | 1 app (Electron) |
| Dashboard | Grafana at `http://<ip>:3001`, login `admin/admin` | Built-in window + tray icon |
| Configuration | Edit `.env` and restart | Settings screen, applied immediately |
| Storage | Prometheus TSDB in a Docker volume | SQLite file in your user folder |
| Speed test | speedtest.net (`speedtest-cli`) | speed.cloudflare.com |
| Jitter | `ping`'s `mdev` (standard deviation) | Mean consecutive difference (true jitter) |
| Home DNS | Must be named `My_DNS_Server`, or the score crashes | Any server can be marked "mine"; auto-detected |
| Sites that block ping | Silently dropped | Shown as "no reply", left out of the score |
| Runs when | Always, on a server | While your computer is on |
| Platforms | Linux (anywhere Docker runs) | Windows, macOS, Linux |

The original Python/Docker code is still in this repo, unchanged. Its instructions are in [docs/DOCKER.md](docs/DOCKER.md).

## Build from source

Requires [Node.js](https://nodejs.org/) 22 or newer.

```sh
git clone https://github.com/UmaisNisar/netprobe_lite.git
cd netprobe_lite/desktop
npm install
npm start            # run in development
npm test             # unit tests
npm run check        # lint + unit tests with coverage thresholds
npm run smoke        # boot the real app, run one probe end to end, exit
npm run dist:win     # -> dist/Netprobe-Setup.exe + Netprobe-Portable.exe
npm run dist:mac     # -> dist/Netprobe-mac-arm64.dmg + Netprobe-mac-x64.dmg (must run on macOS)
npm run dist:linux   # -> dist/Netprobe-linux.AppImage
```

> Running from a VS Code terminal? VS Code sets `ELECTRON_RUN_AS_NODE=1`, which stops Electron from starting as an app. Unset it first: `set ELECTRON_RUN_AS_NODE=` (cmd), `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell) or `unset ELECTRON_RUN_AS_NODE` (bash).

### Tests

| Suite | What it covers |
|---|---|
| `test/probe.test.js` | Ping output parsing (Windows, localized Windows, macOS, Linux), per-OS `ping` arguments, parallel-stream aggregation, jitter, DNS timing against a local fake DNS server (success, SERVFAIL, timeout, bad address) |
| `test/speedtest.test.js` | Throughput math, 500 MB cap, request count, HTTP 429/403/500 and network failures (fake `fetch`) |
| `test/score.test.js` | Quality score formula, thresholds, non-replying sites, outages, home-DNS selection |
| `test/db.test.js` | SQLite writes, time-window queries, bucket averaging, retention pruning, atomic saves, persistence |
| `test/settings.test.js` | Defaults, first-run DNS detection, validation and clamping, corrupt files, persistence |
| `test/renderer-lib.test.js` | Dashboard formatting, colour levels, chart data pivoting and gap handling, HTML escaping |
| `scripts/smoke.js` | Launches the real Electron app and checks the dashboard loads without errors and a full probe is stored and rendered |

Coverage minimums (90% lines, 90% functions, 80% branches) are enforced by `npm run check`. `main.js`, `preload.js` and `app.js` are covered by the smoke test instead.

### CI/CD

- **[Desktop CI](.github/workflows/desktop-ci.yml)** runs on every push and pull request that touches `desktop/`:
  - lint plus unit tests with coverage on Node 22 and 24
  - unit tests, the Electron smoke test and an unsigned packaging check on Windows, macOS and Linux
  - installers uploaded as build artifacts for 7 days
- **[Desktop release](.github/workflows/desktop-release.yml)** runs when a `desktop-v<semver>` tag is pushed:
  - checks the tag format
  - runs the full CI
  - builds all installers with the version taken from the tag
  - publishes a GitHub Release with `SHA256SUMS.txt`
  - tags with a suffix (for example `desktop-v1.1.0-beta.1`) are published as pre-releases
- **Dependabot** checks npm and GitHub Actions dependencies weekly.

To release:

```sh
git tag desktop-v1.0.1 && git push origin desktop-v1.0.1
```

The Docker version keeps upstream's `v*` tags; desktop releases use `desktop-v*` so the two never collide.

### Project layout

```
desktop/
├── src/
│   ├── main/
│   │   ├── main.js        # app lifecycle, tray, scheduling, IPC
│   │   ├── probe.js       # ping (loss/latency/jitter) + DNS timing
│   │   ├── speedtest.js   # Cloudflare bandwidth test
│   │   ├── score.js       # Internet Quality Score
│   │   ├── db.js          # SQLite history (node:sqlite), downsampling, retention
│   │   └── settings.js    # settings.json, defaults, validation, DNS auto-detect
│   ├── preload.js         # safe IPC bridge to the dashboard
│   └── renderer/          # dashboard UI (HTML/CSS/JS + uPlot charts)
├── assets/                # app and tray icons (generated by `npm run icons`)
├── scripts/               # smoke test, icon generator, screenshot helper
└── test/                  # node:test unit tests
```

It has no native modules and no bundler. Storage uses the SQLite built into Electron's Node runtime, and the only runtime dependency is [uPlot](https://github.com/leeoniya/uPlot) for charts.

## Credits and license

The original Netprobe design, metrics and Internet Quality Score come from **[plaintextpackets](https://github.com/plaintextpackets)** ([netprobe_lite](https://github.com/plaintextpackets/netprobe_lite), [video tutorial](https://youtu.be/Wn31husi6tc)). To support their work: [buymeacoffee.com/plaintextpm](https://buymeacoffee.com/plaintextpm).

The desktop port is by [Umais Nisar](https://github.com/UmaisNisar).

This project inherits the original's license terms:

> This project is released under a custom license that restricts commercial use. You are free to use, modify, and distribute the software for non-commercial purposes. Commercial use of this software is strictly prohibited without prior permission. If you have any questions or wish to use this software commercially, please contact [plaintextpackets@gmail.com].
