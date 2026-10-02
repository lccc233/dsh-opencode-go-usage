// Contract check for the browser half.
//
// Materializes the bundle with a minimal React stand-in and asserts the pieces
// the real shell depends on:
//   1. the module registers exactly once, under the PACKAGE NAME (a mismatch
//      makes the shell re-fetch it, and the duplicate registration is fatal to
//      the whole web boot);
//   2. every requested external is part of the platform baseline or declared in
//      dsh.client.external;
//   3. the compact chip shows the most-used window, sits to the right of the
//      context meter (`order: 1`) and draws a threshold-coloured ring;
//   4. opening it renders one progress bar + description per quota window, with
//      the reset countdown, in both locales;
//   5. it registers into the composer dock, and a throwing slot registry is
//      contained instead of failing the boot.
import fs from 'node:fs';
import path from 'node:path';

// The plugin directory under test: defaults to the workspace copy, and accepts
// an explicit path so a relocated install (for example ~/.dsh/plugins/...) can
// be verified the same way.
const pluginDir = process.argv[2] ?? 'dsh-opencode-go-usage';

let registration = null;
let registrationCount = 0;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registrationCount += 1;
      if (registration !== null) throw new Error(`duplicate factory registration for "${entry.id}"`);
      registration = entry;
    },
  },
  innerWidth: 1280,
  innerHeight: 800,
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  clearTimeout: () => {},
  setTimeout: (fn) => {
    fn();
    return 0;
  },
};
globalThis.document = {
  visibilityState: 'visible',
  body: { kind: 'body' },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.Node = class Node {};
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return {
      ok: true,
      fetchedAt: new Date(Date.now() - 90_000).toISOString(),
      windows: {
        rolling: { status: 'ok', percent: 3, resetsAt: new Date(Date.now() + 3 * 3600_000 + 25 * 60_000).toISOString() },
        weekly: { status: 'ok', percent: 61, resetsAt: new Date(Date.now() + 2 * 86400_000).toISOString() },
        monthly: { status: 'ok', percent: 88, resetsAt: new Date(Date.now() + 9 * 86400_000).toISOString() },
      },
      stale: false,
      error: null,
    };
  },
});

// The thinnest React that runs this component: module-level state keeps writes,
// and render() re-runs the component so each rewrite becomes visible.
const hooks = { effects: 0, states: 0, refs: 0 };
const cleanups = [];
const state = [];
const refs = [];
let cursor = 0;
let dirty = false;
const react = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat() } };
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = cursor;
    cursor += 1;
    hooks.states += 1;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [
      state[index],
      (next) => {
        state[index] = typeof next === 'function' ? next(state[index]) : next;
        dirty = true;
      },
    ];
  },
  useEffect(fn) {
    hooks.effects += 1;
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  },
  useCallback(fn) {
    return fn;
  },
  useRef(value) {
    // Real React keeps one ref object per hook position; so does this ledger,
    // otherwise a node assigned after one pass would vanish on the next.
    const index = cursor;
    cursor += 1;
    hooks.refs += 1;
    refs[index] ??= { current: value };
    return refs[index];
  },
};

/** The box a stubbed element reports, so the panel can anchor to it. */
const FAKE_RECT = { top: 700, right: 980, bottom: 720, left: 880, width: 100, height: 20, x: 880, y: 700 };

/**
 * Assign each element's ref to a fake DOM node, as the real renderer would.
 * @param node - the element tree just rendered.
 */
function applyRefs(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(applyRefs);
    return;
  }
  const ref = node.props?.ref;
  if (ref !== null && typeof ref === 'object' && 'current' in ref) {
    ref.current = {
      getBoundingClientRect: () => FAKE_RECT,
      contains: (target) => target === node,
    };
  }
  applyRefs(node.props?.children);
}

/**
 * Find the first element matching a predicate anywhere in a tree.
 * @param node - element tree root.
 * @param predicate - matcher.
 * @returns the first match, or null.
 */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

/**
 * Collect every element matching a predicate.
 * @param node - element tree root.
 * @param predicate - matcher.
 * @returns the matches.
 */
function findAll(node, predicate) {
  const out = [];
  const visit = (item) => {
    if (item === null || item === undefined || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (predicate(item)) out.push(item);
    visit(item.props?.children);
  };
  visit(node);
  return out;
}

/**
 * Flatten an element tree into its text.
 * @param node - element tree root.
 * @returns the concatenated text.
 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf(node.props?.children);
}

/**
 * Render the component until its state writes settle.
 * @param component - the component function.
 * @param props - the props to render with.
 * @returns the settled element tree.
 */
function render(component, props) {
  let tree;
  for (let pass = 0; pass < 12; pass += 1) {
    cursor = 0;
    dirty = false;
    tree = component(props);
    applyRefs(tree);
    if (!dirty) break;
  }
  return tree;
}

const source = fs.readFileSync(path.join(pluginDir, 'lib/client.js'), 'utf8');
(0, eval)(source);

const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));

// --- 1. registration contract
if (registrationCount !== 1) throw new Error(`the bundle registered ${String(registrationCount)} times`);
if (registration.id !== manifest.name) {
  throw new Error(
    `registration id must equal the package name: the shell keys the boot graph by package name, ` +
      `and a mismatch re-fetches this bundle (duplicate registration is fatal to the web boot)`,
  );
}
console.log(`registration: id=${registration.id} (== package name), registered ${String(registrationCount)}x`);

// --- 2. externals contract
const externals = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
const baseline = new Set(['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis']);
const declared = new Set(manifest.dsh?.client?.external ?? []);
const undeclared = externals.filter((name) => !baseline.has(name) && !declared.has(name));
console.log('externals:', JSON.stringify([...new Set(externals)]));
if (undeclared.length > 0) throw new Error(`externals missing from dsh.client.external: ${undeclared.join(', ')}`);

const client = registration.factory((name) => {
  if (name === 'react') return react;
  if (name === 'react-dom') return { createPortal: (node) => node };
  throw new Error(`unexpected external request: ${name}`);
});
console.log('exports:', Object.keys(client), 'inject:', JSON.stringify(client.inject));

for (const language of ['zh', 'en']) {
  // Each scenario starts from a fresh component state ledger: the ledger is
  // module-global, so a panel left open by the previous scenario would leak.
  state.length = 0;
  refs.length = 0;
  const props = { language, sessionId: 's1' };
  // First render starts the effect's fetch; drain it, then render the settled state.
  render(client.UsageBar, props);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  const chip = render(client.UsageBar, props);

  // --- 3. compact chip: three rings, no visible text
  const compact = textOf(chip).trim();
  console.log(`[${language}] compact text: ${JSON.stringify(compact)}`);
  if (compact !== '') throw new Error(`the compact chip must render no text, rendered ${JSON.stringify(compact)}`);
  if (chip.props?.style?.order !== 1) {
    throw new Error('the chip must carry order: 1 so it renders to the right of the context meter');
  }
  const ringSlots = findAll(chip, (node) => node.type === client.QuotaRing);
  if (ringSlots.length !== 3) throw new Error(`expected three rings, saw ${String(ringSlots.length)}`);
  const ringSpecs = ringSlots.map((node) => `${String(node.props.percent)}/${String(node.props.tone)}`);
  console.log('[', language, '] rings (window order):', ringSpecs.join(', '));
  if (ringSpecs.join(',') !== '3/ok,61/warn,88/danger') {
    throw new Error(`rings must map windows to their own threshold tones in order, saw ${ringSpecs.join(', ')}`);
  }
  const ringTitles = findAll(chip, (node) => typeof node.props?.title === 'string').map((node) => node.props.title);
  console.log('[', language, '] ring tooltips:', ringTitles.join(' | '));
  const perRing = ringTitles.filter((title) => /剩余|left/.test(title));
  if (perRing.length !== 3) throw new Error(`each of the three rings must carry its own detail tooltip, saw ${String(perRing.length)}`);
  // Draw the ring directly and check the progress stroke it emits.
  const drawn = client.QuotaRing({ percent: 88, tone: 'danger' });
  const ringFill = find(drawn, (node) => node.type === 'circle' && node.props.strokeLinecap === 'round');
  if (ringFill === null) throw new Error('the ring has no progress stroke');
  if (ringFill.props.stroke !== 'var(--dsw-alias-state-error-primary, #f85149)') {
    throw new Error(`88% must draw the danger tone, drew ${String(ringFill.props.stroke)}`);
  }
  const half = client.QuotaRing({ percent: 50, tone: 'ok' });
  const halfFill = find(half, (node) => node.type === 'circle' && node.props.strokeLinecap === 'round');
  if (Number(halfFill.props.strokeDashoffset) !== Number(halfFill.props.strokeDasharray) / 2) {
    throw new Error('the ring stroke must encode the percentage as a half-circle at 50%');
  }

  // --- 4. hover opens the detail panel (the chip's own hover handlers), and the
  // trigger stays a real button for keyboard and click access.
  const trigger = find(chip, (node) => node.type === 'button');
  if (trigger === null || typeof trigger.props.onClick !== 'function') {
    throw new Error('the chip must expose a button trigger for click and keyboard access');
  }
  if (typeof trigger.props.onFocus !== 'function' || trigger.props['aria-haspopup'] !== 'dialog') {
    throw new Error('the trigger must open the dialog on focus and announce it with aria-haspopup');
  }
  if (typeof chip.props?.onMouseEnter !== 'function') throw new Error('the chip must open on hover');
  chip.props.onMouseEnter();
  const opened = render(client.UsageBar, props);
  const panel = find(opened, (node) => node.props?.role === 'dialog');
  if (panel === null) throw new Error('hovering the chip must open the detail panel');
  const texts = textOf(panel);
  console.log(`[${language}] panel:`, texts.trim());
  const bars = findAll(panel, (node) => node.props?.style?.borderRadius === '999px' && node.props?.style?.height === '6px');
  if (bars.length !== 3) throw new Error(`expected three merged bar tracks, saw ${String(bars.length)}`);
  const fillColors = findAll(panel, (node) => typeof node.props?.style?.width === 'string' && node.props.style.width.endsWith('%') && node.props.style.background !== undefined).map(
    (node) => node.props.style.background,
  );
  if (!fillColors.includes('var(--dsw-alias-state-success-primary, #2ea043)')) throw new Error('3% must draw the ok tone');
  if (!fillColors.includes('var(--dsw-alias-state-warning-primary, #d29922)')) throw new Error('61% must draw the warn tone');
  if (!fillColors.includes('var(--dsw-alias-state-error-primary, #f85149)')) throw new Error('88% must draw the danger tone');
  if (!texts.includes('↻')) throw new Error('the panel must carry the reset countdown');
  if (!/剩余|left/.test(texts)) throw new Error('the panel must describe the remaining quota');
  const refresh = findAll(panel, (node) => node.type === 'button').find((node) => textOf(node).includes('↻'));
  if (refresh === undefined) throw new Error('the panel must offer a manual refresh');
}

// --- 5. slot registration
const registrations = [];
const ctx = {
  get: (name) => {
    if (name === 'modelDirectories') {
      return { directoryFor: () => ({ getSnapshot: () => ({ selection: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }) }) };
    }
    if (name === 'slots') {
      return {
        inject: (slot, install) => {
          install();
        },
        register: (entry, component) => {
          registrations.push({ entry, component });
          return () => {};
        },
      };
    }
    return undefined;
  },
  logger: { warn: (message) => console.log('[warn]', message) },
};
client.apply(ctx);
console.log('registrations:', registrations.map((entry) => `${entry.entry.name}#${entry.entry.id}@${String(entry.entry.order)}`));
if (registrations.length !== 1 || registrations[0].entry.name !== 'conversation.composer.dock') {
  throw new Error('the chip did not register into the composer dock');
}
if (registrations[0].entry.inject('session-1').provider !== 'opencode-go') {
  throw new Error('the active provider was not detected');
}

// --- 6. a throwing slot registry must not propagate (it would fail the web boot)
const failing = {
  logger: { warn: (message) => console.log('[warn]', message) },
  get: (name) =>
    name === 'slots'
      ? {
          inject: () => {
            throw new Error('boom');
          },
          register: () => () => {},
        }
      : undefined,
};
client.apply(failing);
console.log('a throwing slot registry is contained (apply returned normally)');
cleanups.forEach((cleanup) => cleanup());
console.log('hooks exercised:', JSON.stringify(hooks));
console.log('CLIENT STRUCTURE CHECK PASSED');
