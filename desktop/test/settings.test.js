const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Settings } = require('../src/main/settings');

test('validates and persists settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-'));
  const s = new Settings(dir);
  const saved = s.set({
    sites: [' example.com ', ''],
    probeInterval: 1,
    dnsServers: [{ name: 'x', ip: '1.1.1.1', home: true }, { name: 'y', ip: '8.8.8.8', home: true }],
  });
  assert.deepStrictEqual(saved.sites, ['example.com']);
  assert.strictEqual(saved.probeInterval, 15);
  assert.deepStrictEqual(saved.dnsServers.map((d) => d.home), [true, false]);
  assert.deepStrictEqual(new Settings(dir).get().sites, ['example.com']);
});
