// @ts-check
/**
 * A host, written against the contract and nothing else.
 *
 * The point of this page is the settings panel: **not one key name appears in this
 * file.** The controls are built by reading the descriptors `config()`, `options()`,
 * `assets()` and `storage()` hand back — their types, their choices, their
 * descriptions, and whether each one applies live or waits for a restart. Point the
 * same code at a different engine and it paints that engine's settings instead.
 *
 * The emulator underneath is a stub (see `stub-module.js`). Everything above it is
 * real.
 */

import { PpssppSDK } from '../src/ppsspp-wasm.js';
import { stubLoader } from './stub-module.js';

/**
 * @typedef {import('../src/payloads.js').PpssppPayloads} PpssppPayloads
 * @typedef {import('@wasm-gaming/engine-specs').PropertyDefinition<unknown>} Definition
 * @typedef {import('../src/ppsspp-wasm.js').PpssppPlay} PpssppPlay
 * @typedef {'config' | 'options' | 'assets' | 'storage'} Kind
 */

/** @param {string} id */
function need(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`demo: #${id} is missing from the page`);
  return element;
}

const stage = need('stage');
const panel = need('panel');
const output = need('log');
const status = need('status');

/** @param {string} line */
function log(line) {
  const at = new Date().toISOString().slice(11, 23);
  output.textContent = `${at}  ${line}\n${output.textContent ?? ''}`;
}

/** @param {string} text */
function setStatus(text) {
  status.textContent = text;
}

// ---- The engine ----

const sdk = new PpssppSDK(
  {
    // Registered in the constructor: the one subscription shape a chain cannot
    // express, because an object literal has nothing to chain onto.
    on: {
      error: (event) => log(`✕ error — ${event.detail.message}`),
      exit: () => {
        log('exit');
        setStatus('stopped');
      },
    },
  },
  // Where the real Emscripten module would go.
  stubLoader(log),
)
  .mount(stage)
  .on('start', (event) => {
    log(`start — ${JSON.stringify(event.detail)}`);
    setStatus('running');
  })
  .on('gameInfo', (event) => log(`game — ${event.detail.title} (${event.detail.id})`))
  .on('fps', (event) => setStatus(`running · ${event.detail.fps.toFixed(2)} fps`))
  .on('pause', (event) => {
    log(`paused by ${event.detail.owner}`);
    setStatus('paused');
  })
  .on('resume', (event) => {
    log(`resumed by ${event.detail.owner}`);
    setStatus('running');
  })
  .on('saveState', (event) => log(`state ${event.detail.action} in slot ${event.detail.slot}`));

/**
 * The live session, once there is one.
 *
 * Typed as `PpssppPlay` rather than as the contract's `EnginePlay`, and the difference
 * is worth noticing: `pause()` and `resume()` are **not** contract members, so a host
 * that wants those buttons has to know it is talking to PPSSPP. What the contract does
 * carry is what they emit — `pause` and `resume` are core events — so a host that
 * stays generic still reacts correctly when PPSSPP's own menu opens.
 */
let play = /** @type {PpssppPlay | null} */ (null);

// ---- A settings screen built from descriptors alone ----

/**
 * One control for one property, chosen from what the descriptor says about it.
 *
 * @param {Kind} kind
 * @param {string} name
 * @param {Definition} definition
 */
function control(kind, name, definition) {
  const row = document.createElement('label');
  row.className = 'row';

  const title = document.createElement('span');
  title.className = 'name';
  title.textContent = name;
  if (definition.live === false) {
    const badge = document.createElement('em');
    // What `live` buys a host: it can tell the user this one needs a restart, instead
    // of changing it and quietly doing nothing.
    badge.textContent = 'restart';
    badge.title = 'Changing this applies at the next restart()';
    title.append(' ', badge);
  }
  row.append(title);

  const input = build(kind, name, definition);
  row.append(input);

  if (definition.description) {
    const hint = document.createElement('small');
    hint.textContent = definition.description;
    row.append(hint);
  }
  return row;
}

/**
 * @param {Kind} kind
 * @param {string} name
 * @param {Definition} definition
 * @returns {HTMLElement}
 */
function build(kind, name, definition) {
  const value = definition.value;

  // A file, because the descriptor says what it accepts.
  if (definition.allowedTypes) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = definition.allowedTypes.join(',');
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void write(kind, name, file);
    });
    return input;
  }

  // A fixed set of choices.
  if (definition.enum) {
    const select = document.createElement('select');
    for (const choice of definition.enum) {
      const option = document.createElement('option');
      option.value = String(choice);
      option.textContent = String(choice);
      option.selected = choice === value;
      select.append(option);
    }
    select.addEventListener('change', () => {
      const chosen = definition.enum?.find((candidate) => String(candidate) === select.value);
      void write(kind, name, chosen);
    });
    return select;
  }

  if (typeof value === 'boolean') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => void write(kind, name, input.checked));
    return input;
  }

  const input = document.createElement('input');
  const numeric = typeof value === 'number';
  input.type = numeric ? 'number' : 'text';
  input.value = value === undefined ? '' : String(value);
  input.addEventListener('change', () => {
    void write(kind, name, numeric ? Number(input.value) : input.value);
  });
  return input;
}

/**
 * Write one property back through the contract.
 *
 * The factory and the session take the same call, which is why this does not care
 * whether anything is running yet: before `start()` it settles what the next session
 * opens with, after it, what this one does.
 *
 * @param {Kind} kind
 * @param {string} name
 * @param {unknown} value
 */
async function write(kind, name, value) {
  const patch = /** @type {never} */ ({ [name]: value });
  const target = play ?? sdk;
  const shown = value instanceof File ? value.name : value instanceof Blob ? `Blob(${value.size})` : String(value);
  log(`${kind}({ ${name}: ${shown} })`);
  try {
    await target[kind](patch);
  } catch (thrown) {
    log(`✕ ${String(thrown)}`);
  }
}

/** Repaint every panel from what the engine currently reports. */
async function paintPanel() {
  const source = play ?? sdk;
  panel.replaceChildren();
  for (const kind of /** @type {Kind[]} */ (['assets', 'config', 'options', 'storage'])) {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = kind;
    group.append(legend);

    const definitions = await source[kind]();
    for (const [name, definition] of Object.entries(definitions)) {
      group.append(control(kind, name, /** @type {Definition} */ (definition)));
    }
    panel.append(group);
  }
}

// ---- Lifecycle ----

// Nobody reading this owns a PSP ISO, and `start()` refuses without a game — that
// refusal is a feature, not something to paper over. So: a stand-in, and deliberately
// an anonymous `Blob` rather than a `File`, because that is the case where the format
// has to be read out of the contents. Watch the log name it `.cso`.
need('standin').addEventListener('click', () => {
  const bytes = new Uint8Array(2048);
  bytes.set([0x43, 0x49, 0x53, 0x4f]); // 'CISO'
  void write('assets', 'game', new Blob([bytes]));
});

need('start').addEventListener('click', async () => {
  setStatus('starting…');
  try {
    play = /** @type {PpssppPlay} */ (await sdk.start());
    await paintPanel();
  } catch (thrown) {
    // The error already arrived as an event too — both ways, always.
    setStatus('failed to start');
    log(`✕ start rejected — ${String(thrown)}`);
  }
});

need('restart').addEventListener('click', async () => {
  if (!play) return log('nothing to restart');
  setStatus('restarting…');
  // A restart is a whole new Emscripten module and a whole new canvas: `main()` runs
  // once, and a canvas hands out one WebGL context for its lifetime.
  try {
    await play.restart();
  } catch (thrown) {
    log(`✕ restart rejected — ${String(thrown)}`);
  }
});

need('pause').addEventListener('click', () => play?.pause('demo-toolbar'));
need('resume').addEventListener('click', () => play?.resume('demo-toolbar'));

need('destroy').addEventListener('click', async () => {
  if (!play) return;
  await play.destroy();
  play = null;
  await paintPanel();
});

// The panel works before there is an engine: a read on the factory answers with the
// settings the next session will open with.
void paintPanel();
log('ready — the settings below were built entirely from the engine\'s descriptors');
