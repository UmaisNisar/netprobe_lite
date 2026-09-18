#!/usr/bin/env node
// Headless Netprobe: the monitoring engine plus the web dashboard, without
// Electron. For always-on machines (a home server, a Raspberry Pi, a PC that
// runs 24/7). Needs Node 22.13 or newer.
//
//   node src/cli.js [--port 7979] [--host 0.0.0.0] [--token SECRET] [--data DIR]
//
// Uses the same data folder as the desktop app by default, so history carries
// over; the two can't run at the same time on the same folder.

const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { Settings } = require('./main/settings');
const { Store } = require('./main/db');
const { Monitor } = require('./main/monitor');
const { createServer, lanAddresses } = require('./main/server');
const lock = require('./main/lock');

function defaultDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Netprobe');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Netprobe');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Netprobe');
}

const HELP = `Netprobe (headless)

Usage: node src/cli.js [options]

  --port <n>      Port for the web dashboard and /metrics (default 7979)
  --host <addr>   Address to listen on (default 127.0.0.1; use 0.0.0.0 for
                  other devices on your network)
  --token <t>     Require this access token from other devices
                  (open http://host:port/?token=<t> once in each browser)
  --data <dir>    Data folder (default: the desktop app's, ${defaultDataDir()})
  --help          Show this help
`;

function main(argv = process.argv.slice(2)) {
  const { values: opt } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: process.env.NETPROBE_PORT ?? '7979' },
      host: { type: 'string', default: process.env.NETPROBE_HOST ?? '127.0.0.1' },
      token: { type: 'string', default: process.env.NETPROBE_TOKEN },
      data: { type: 'string', default: process.env.NETPROBE_DATA ?? defaultDataDir() },
      help: { type: 'boolean', default: false },
    },
  });
  if (opt.help) {
    process.stdout.write(HELP);
    return null;
  }
  const port = Number(opt.port);
  // 0 = any free port (the log shows which).
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${opt.port}`);

  const held = lock.acquire(opt.data);
  const settings = new Settings(opt.data);
  const monitor = new Monitor({ settings, store: new Store(opt.data) });
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  monitor.on('incident', ({ type, incident }) => log(`incident ${type}: ${incident.kind}${incident.where ? ` (likely ${incident.where})` : ''}`));

  const server = createServer({
    monitor,
    token: opt.token || null,
    log,
    saveSettings: (next) => {
      const before = settings.get();
      const saved = settings.set(next);
      monitor.applySettings(before, saved);
      return saved;
    },
  });
  server.listen(port, opt.host, () => {
    const hosts = opt.host === '0.0.0.0' ? ['localhost', ...lanAddresses()] : [opt.host];
    log(`Netprobe monitoring. Data: ${opt.data}`);
    const actual = server.address().port;
    for (const h of hosts) log(`Dashboard: http://${h}:${actual}/   Metrics: http://${h}:${actual}/metrics`);
    if (opt.host !== '127.0.0.1' && !opt.token) log('Other devices can view the dashboard; changes are only allowed from this machine.');
  });
  monitor.start();

  const stop = () => {
    log('Stopping.');
    server.close();
    monitor.stop();
    monitor.store.close();
    held.release();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { server, monitor, stop };
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(e.code === 'ELOCKED' ? 2 : 1);
  }
}

module.exports = { main, defaultDataDir, HELP };
