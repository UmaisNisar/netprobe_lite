const test = require('node:test');
const assert = require('node:assert');
const { traceroute, commands, deps } = require('../src/main/trace');

function withDeps(overrides, fn) {
  const saved = { ...deps };
  Object.assign(deps, overrides);
  return Promise.resolve(fn()).finally(() => Object.assign(deps, saved));
}

test('uses tracert on Windows and traceroute/tracepath elsewhere', async () => {
  await withDeps({ platform: 'win32' }, () => assert.deepStrictEqual(commands('x').map((c) => c[0]), ['tracert']));
  await withDeps({ platform: 'linux' }, () => assert.deepStrictEqual(commands('x').map((c) => c[0]), ['traceroute', 'tracepath']));
});

test('returns the trace output', async () => {
  const execFile = async () => ({ stdout: '  1  192.168.1.1  2 ms\n' });
  const out = await withDeps({ platform: 'win32', execFile }, () => traceroute('1.1.1.1'));
  assert.strictEqual(out, '1  192.168.1.1  2 ms');
});

test('keeps partial output when the tool exits non-zero', async () => {
  const execFile = async () => {
    throw Object.assign(new Error('exit 1'), { stdout: '1 * * *\n' });
  };
  assert.strictEqual(await withDeps({ platform: 'win32', execFile }, () => traceroute('x')), '1 * * *');
});

test('falls back to tracepath when traceroute is missing', async () => {
  const calls = [];
  const execFile = async (cmd) => {
    calls.push(cmd);
    if (cmd === 'traceroute') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { stdout: ' 1?: [LOCALHOST]\n' };
  };
  const out = await withDeps({ platform: 'linux', execFile }, () => traceroute('x'));
  assert.deepStrictEqual(calls, ['traceroute', 'tracepath']);
  assert.match(out, /LOCALHOST/);
});

test('explains when no tool is installed, and reports other failures', async () => {
  const missing = async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  assert.match(await withDeps({ platform: 'linux', execFile: missing }, () => traceroute('x')), /not available/);
  const broken = async () => {
    throw Object.assign(new Error('boom'), { code: 1 });
  };
  assert.match(await withDeps({ platform: 'win32', execFile: broken }, () => traceroute('x')), /Traceroute failed: boom/);
});
