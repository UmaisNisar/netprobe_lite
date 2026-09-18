const test = require('node:test');
const assert = require('node:assert');
const { parseRtts, jitterOf } = require('../src/main/probe');

test('parses Windows, localised Windows and Unix reply lines', () => {
  const out = [
    'Reply from 1.1.1.1: bytes=32 time=12ms TTL=57',
    'Reply from 1.1.1.1: bytes=32 time<1ms TTL=57',
    'Antwort von 1.1.1.1: Bytes=32 Zeit=15ms TTL=57',
    'Réponse de 1.1.1.1 : octets=32 temps=14 ms TTL=57',
    '64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=11.4 ms',
  ].join('\r\n');
  assert.deepStrictEqual(parseRtts(out), [12, 0.5, 15, 14, 11.4]);
});

test('ignores timeouts, unreachable replies and summary lines', () => {
  const out = [
    'Request timed out.',
    'Reply from 192.168.1.1: Destination host unreachable.',
    '    Minimum = 10ms, Maximum = 12ms, Average = 11ms',
    'rtt min/avg/max/mdev = 10.1/11.2/12.3/0.8 ms',
  ].join('\n');
  assert.deepStrictEqual(parseRtts(out), []);
});

test('jitter is mean absolute difference of consecutive RTTs per stream', () => {
  assert.strictEqual(jitterOf([[10, 12, 10], [20, 20]]), (2 + 2 + 0) / 3);
  assert.strictEqual(jitterOf([[10]]), 0);
});
