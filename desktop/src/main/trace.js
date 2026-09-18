// Full traceroute, captured when an incident starts so there is a record of
// where packets were getting lost at the time.

const childProcess = require('node:child_process');
const { promisify } = require('node:util');

// Swappable in tests.
const deps = { platform: process.platform, execFile: promisify(childProcess.execFile) };

function commands(target) {
  if (deps.platform === 'win32') return [['tracert', ['-d', '-h', '15', '-w', '800', target]]];
  return [
    ['traceroute', ['-n', '-m', '15', '-w', '1', '-q', '2', target]],
    ['tracepath', ['-n', '-m', '15', target]], // Linux without traceroute
  ];
}

async function traceroute(target) {
  for (const [cmd, args] of commands(target)) {
    try {
      const { stdout } = await deps.execFile(cmd, args, { timeout: 90_000, windowsHide: true });
      return stdout.trim();
    } catch (e) {
      // Tools exit non-zero when the destination is unreachable but still
      // print a useful partial trace.
      if (e.stdout?.trim()) return e.stdout.trim();
      if (e.code !== 'ENOENT') return `Traceroute failed: ${e.message}`;
    }
  }
  return 'Traceroute is not available on this system (install "traceroute").';
}

module.exports = { traceroute, commands, deps };
