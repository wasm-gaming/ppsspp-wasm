/**
 * Point the smoke runner at things that fail on purpose, and check it says so.
 *
 * `tests/smoke.mjs` exists to deliver bad news about the port. That makes its own
 * failure modes the ones worth testing: a runner that reports RUNNING whatever it is
 * shown is worse than no runner, because a round then ends in a green tick that means
 * nothing. Each case in `tests/fakes/` is built to land on exactly one verdict.
 *
 * This is deliberately not a `*.test.mjs` file. `make test` must run with no browser
 * anywhere — that is the point of the fake-module suite — and this needs Chromium.
 *
 * Usage: node tests/smoke-selftest.mjs [--timeout=12] [--settle=2] [--chromium=PATH]
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

// Short, because every one of these reaches its verdict in seconds and three of them
// only reach it by running out of time.
const TIMEOUT = args.timeout ?? '12';
const SETTLE = args.settle ?? '2';

// `alsoExpect` is checked against the whole transcript rather than the verdict line, and
// is where the diagnostic counters are pinned: a number nobody checks is a number that
// quietly stops being computed.
const CASES = [
  {
    dir: 'draws',
    code: 0,
    expect: /^DRAWING —/m,
    alsoExpect: /foreignFrames=[1-9]/,
    why: 'a canvas with colour on it passes, and its animation frames are seen',
  },
  { dir: 'clears', code: 1, expect: /^CLEARED, NOT DRAWN —/m, why: 'a uniform canvas is not a picture' },
  { dir: 'blank', code: 1, expect: /^BLANK —/m, why: 'a live loop that never paints fails' },
  {
    dir: 'offscreen',
    code: 1,
    expect: /^BLANK —/m,
    alsoExpect: /clears \(0 to it\)/,
    why: 'a renderer that never blits is told apart from one that never runs',
  },
  { dir: 'blocks', code: 1, expect: /^BLOCKED —/m, why: 'a held main thread is still reported, not hung on' },
  {
    dir: 'hangs',
    code: 1,
    expect: /^STOPPED at "instantiating"/m,
    alsoExpect: /foreignFrames=0/,
    why: 'a factory that never settles is named, and nothing scheduled a frame',
  },
];

let failed = 0;
for (const c of CASES) {
  process.stdout.write(`\n── ${c.dir}: ${c.why}\n`);
  const run = spawnSync(
    process.execPath,
    [
      join(here, 'smoke.mjs'),
      `--artifacts=${join(here, 'fakes', c.dir)}`,
      `--timeout=${TIMEOUT}`,
      `--settle=${SETTLE}`,
      ...(args.chromium ? [`--chromium=${args.chromium}`] : []),
    ],
    { encoding: 'utf8' },
  );
  const out = (run.stdout ?? '') + (run.stderr ?? '');
  const verdict = out.match(/^(?:DRAWING|CLEARED, NOT DRAWN|BLANK|BLOCKED|STOPPED|RUNNING|CRASHED|FAILED|ALIVE BUT STALLED|NO ANSWER|NO PICTURE READ)\b.*$/m)?.[0];
  const ok = run.status === c.code && c.expect.test(out) && (!c.alsoExpect || c.alsoExpect.test(out));
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} exit ${run.status} (want ${c.code})`);
  console.log(`        ${verdict ?? '(no verdict line found)'}`);
  if (!ok) {
    failed++;
    // The transcript, but only when it is needed: these runs are noisy by design.
    console.log(out.split('\n').slice(-40).map((l) => '        | ' + l).join('\n'));
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} verdicts as specified`);
process.exit(failed ? 1 : 0);
