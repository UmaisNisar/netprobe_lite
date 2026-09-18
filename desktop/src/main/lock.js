// One monitor per data folder: the desktop app and the headless service
// must not both write probes into the same database. A lock file holds the
// owner's PID; a lock left behind by a dead process is taken over.

const fs = require('node:fs');
const path = require('node:path');

// Swappable in tests.
const deps = {
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM'; // exists but owned by someone else
    }
  },
};

function acquire(dir, pid = process.pid) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'netprobe.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' });
      return { file, release: () => release(file, pid) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = Number(fs.readFileSync(file, 'utf8'));
      if (owner && owner !== pid && deps.alive(owner)) {
        const err = new Error(`Netprobe is already running for this data folder (process ${owner}).`);
        err.code = 'ELOCKED';
        err.owner = owner;
        throw err;
      }
      fs.rmSync(file, { force: true }); // stale: take it over
    }
  }
  throw new Error('Could not acquire the Netprobe lock.');
}

function release(file, pid) {
  try {
    if (Number(fs.readFileSync(file, 'utf8')) === pid) fs.rmSync(file, { force: true });
  } catch {
    // Already gone.
  }
}

module.exports = { acquire, deps };
