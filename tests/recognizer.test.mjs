import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const { outputFiles } = buildSync({
  entryPoints: [fileURLToPath(new URL('../gesture/recognizer.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs',
});
const module = { exports: {} };
vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports });
const { GestureRecognizer } = module.exports;

function recognize(points, options = {}) {
  const recognizer = new GestureRecognizer({ enableDiagonals: true, ...options });
  recognizer.start(0, 0);
  for (const [x, y] of points) recognizer.track(x, y);
  return Array.from(recognizer.finish());
}

test('diagonals are opt-in and preserve existing option-off classification and anchors', () => {
  const cases = [
    { points: [[120, -120]], expected: ['up'] },
    { points: [[120, 0], [300, 0], [300, 120]], expected: ['right'] },
    { points: [[120, 0], [0, 0]], expected: ['LR-LR'] },
    { points: [[0, -120], [0, 0]], expected: ['UD-UD'] },
    { points: [[0, 120], [120, 120]], expected: ['down', 'right'] },
  ];
  for (const { points, expected } of cases) {
    assert.deepEqual(recognize(points, { enableDiagonals: false }), expected);
    const recognizer = new GestureRecognizer();
    recognizer.start(0, 0);
    for (const [x, y] of points) recognizer.track(x, y);
    assert.deepEqual(Array.from(recognizer.finish()), expected);
  }
});

test('recognizes all four straight diagonals from sparse and dense samples', () => {
  for (const [sx, sy, direction] of [
    [1, -1, 'up-right'], [-1, 1, 'down-left'],
    [1, 1, 'down-right'], [-1, -1, 'up-left'],
  ]) {
    assert.deepEqual(recognize([[120 * sx, 120 * sy]]), [direction]);
    assert.deepEqual(recognize(Array.from({ length: 30 }, (_, i) => [
      (i + 1) * 6 * sx, (i + 1) * 6 * sy,
    ])), [direction]);
  }
});

test('keeps the per-axis movement threshold, including its strict boundary', () => {
  assert.deepEqual(recognize([[60, 60]]), []);
  assert.deepEqual(recognize([[61, 61]]), ['down-right']);
  assert.deepEqual(recognize([[20, -20]], { thresholdPx: 20 }), []);
  assert.deepEqual(recognize([[21, -21]], { thresholdPx: 20 }), ['up-right']);
  assert.deepEqual(recognize([[0, 60]]), []);
  assert.deepEqual(recognize([[0, 61]]), ['down']);
});

test('classifies directions on either side of the initial diagonal angle boundary', () => {
  assert.deepEqual(recognize([[120, 45]]), ['right']);
  assert.deepEqual(recognize([[120, 55]]), ['down-right']);
  assert.deepEqual(recognize([[45, 120]]), ['down']);
  assert.deepEqual(recognize([[55, 120]]), ['down-right']);
});

test('small direction noise and angle-boundary jitter do not add spurious segments', () => {
  const noisyDiagonal = Array.from({ length: 40 }, (_, i) => [
    (i + 1) * 6, -(i + 1) * 6 + (i % 2 ? 2 : -2),
  ]);
  assert.deepEqual(recognize(noisyDiagonal), ['up-right']);
  assert.deepEqual(recognize([[120, 45], [160, 64], [200, 82], [240, 101]]), ['right']);
  assert.deepEqual(recognize([[120, 55], [160, 70], [200, 85], [240, 100]]), ['down-right']);
});

test('long smooth cardinal legs retain every perpendicular two-step combination', () => {
  const axes = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] };
  for (const [first, [dx, dy]] of Object.entries(axes)) {
    for (const [second, [sx, sy]] of Object.entries(axes)) {
      if (dx * sx + dy * sy !== 0) continue;
      const points = Array.from({ length: 51 }, (_, i) => [dx * (i + 1) * 7, dy * (i + 1) * 7]);
      for (let i = 1; i <= 20; i++) points.push([dx * 357 + sx * i * 7, dy * 357 + sy * i * 7]);
      assert.deepEqual(recognize(points), [first, second], `${first}, ${second}`);
    }
  }
});

test('noisy long cardinal motion and a short corner overshoot retain a cardinal turn', () => {
  const points = Array.from({ length: 50 }, (_, i) => [(i + 1) * 7, i % 2 ? 2 : -2]);
  points.push([357, 0], [360, 5], [362, 12], [362, 40], [362, 90]);
  assert.deepEqual(recognize(points), ['right', 'down']);
});

test('long cardinal reversals retain the existing alternating gesture tokens', () => {
  assert.deepEqual(recognize([[120, 0], [300, 0], [220, 0]]), ['LR-LR']);
  assert.deepEqual(recognize([[0, -120], [0, -300], [0, -220]]), ['UD-UD']);
});

test('rejects mixed diagonal chains, diagonal turns and diagonal reversals', () => {
  for (const points of [
    [[120, -120], [240, -120]],
    [[120, 0], [240, -120]],
    [[120, -120], [240, 0]],
    [[120, -120], [0, 0]],
    [[0, 120], [120, 120], [240, 0]],
  ]) assert.deepEqual(recognize(points), []);
});

test('cancellation clears feedback, remains canceled until restart, and honors no stale pattern', () => {
  const recognizer = new GestureRecognizer({ enableDiagonals: true });
  const updates = [];
  const onChange = (segments) => updates.push(Array.from(segments));
  recognizer.start(0, 0);
  recognizer.track(120, -120, onChange);
  assert.equal(recognizer.isCanceled(), false);
  recognizer.track(240, -120, onChange);
  assert.equal(recognizer.isCanceled(), true);
  assert.deepEqual(Array.from(recognizer.finish()), []);
  recognizer.track(360, -240, onChange);
  assert.deepEqual(updates, [['up-right'], []]);
  recognizer.start(30, 40);
  assert.equal(recognizer.isCanceled(), false);
  recognizer.track(-90, 160, onChange);
  assert.deepEqual(Array.from(recognizer.finish()), ['down-left']);
});

test('sub-threshold endpoint jitter does not cancel a diagonal', () => {
  assert.deepEqual(recognize([[120, -120], [125, -119], [115, -117], [122, -121]]), ['up-right']);
});

test('a segment limit cannot hide an unsupported diagonal continuation', () => {
  assert.deepEqual(recognize([[120, -120], [240, -120]], { maxSegments: 1 }), []);
  assert.deepEqual(recognize([[120, 0], [240, -120]], { maxSegments: 1 }), []);
});
