// Headless-Chromium REPL for driving Tracer. Reads one command per line from stdin, so pipe a
// heredoc or run it under tmux. Each command prints one line starting with "ok" or "error".
//
//   node .claude/skills/run-tracer/driver.mjs [baseUrl]    # default http://localhost:5099
//
// Screenshots go to .claude/skills/run-tracer/out/ (override with TRACER_SHOTS=dir).
// Run `help` for the command list.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:5099';
const OUT = process.env.TRACER_SHOTS ?? resolve(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

// After a build, the force layout keeps moving and the view only fits once it settles.
// Screenshots or clicks before then hit an unfitted view.
const SETTLE_MS = 6000;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const status = () => page.locator('[role=status]').textContent();
const shown = async () =>
  (await page.getByText(/^Showing \d+ of \d+$/).count())
    ? page.getByText(/^Showing \d+ of \d+$/).textContent()
    : 'no graph';

async function waitForBuild() {
  await page.waitForFunction(
    () => !/Building|Re-anchoring/.test(document.querySelector('[role=status]')?.textContent ?? ''),
    null,
    { timeout: 120000 },
  );
  const alert = page.getByRole('alert');
  if (await alert.count()) throw new Error(`app error: ${await alert.first().textContent()}`);
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * Waits until the graph canvas stops resizing. Opening or closing the details panel narrows
 * or widens the canvas over a few hundred ms; scanning or clicking mid-resize misses nodes.
 */
const canvasSize = () =>
  page.evaluate(() => {
    const c = document.querySelector('.graph-view canvas');
    return c ? `${c.width}x${c.height}` : '';
  });

async function waitForStableCanvas() {
  let last = '';
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const size = await canvasSize();
    stable = size === last ? stable + 1 : 0;
    last = size;
    await page.waitForTimeout(100);
  }
}

/**
 * Nodes are drawn on a canvas, not in the DOM. The app exposes their screen positions through
 * window.__tracerAutomation when loaded with ?automation (nav adds it), so clicks are exact
 * whatever the zoom, colors, or icons.
 */
async function visibleNodes() {
  await waitForStableCanvas();
  const nodes = await page.evaluate(() => window.__tracerAutomation?.nodes() ?? null);
  if (!nodes) throw new Error('automation hook missing (use nav, which adds ?automation)');
  // Raster order: top to bottom, then left to right (oldest first at default angles).
  return nodes.sort((a, b) => a.y - b.y || a.x - b.x);
}

async function clickNode(node, label) {
  const panelWasOpen = (await page.locator('.details').count()) > 0;
  const sizeBefore = await canvasSize();
  await page.mouse.click(node.x, node.y);
  // Opening the panel shrinks the canvas, but not instantly: wait for the resize to start,
  // or a "stable" reading of the old size passes and the next command runs mid-resize.
  if (!panelWasOpen) {
    for (let i = 0; i < 20 && (await canvasSize()) === sizeBefore; i++) {
      await page.waitForTimeout(100);
    }
  }
  await waitForStableCanvas();
  if (!(await page.locator('.details').count())) throw new Error('click did not select a node');
  return `${await page.locator('#details-title').textContent()} (${label})`;
}

async function selectByKind(kind, n) {
  const matching = (await visibleNodes()).filter((node) => node.relation === kind);
  if (!matching.length) throw new Error(`no ${kind} nodes visible`);
  const index = Math.min(n, matching.length);
  return clickNode(matching[index - 1], `${kind} ${index} of ${matching.length}`);
}

async function selectByTitle(text) {
  const needle = text.toLowerCase();
  const node = (await visibleNodes()).find((n) => n.title?.toLowerCase().includes(needle));
  if (!node) throw new Error(`no visible node title contains "${text}"`);
  return clickNode(node, node.relation);
}

/** Fallback: probe clicks outward from a point on the canvas (fractions of its size). */
async function selectNear(fx, fy) {
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('no canvas (build a graph first)');
  const cx = box.x + box.width * fx;
  const cy = box.y + box.height * fy;
  for (let r = 0; r <= 300; r += 12) {
    for (let a = 0; a < 360; a += r === 0 ? 360 : 30) {
      const x = cx + r * Math.cos((a * Math.PI) / 180);
      const y = cy + r * Math.sin((a * Math.PI) / 180);
      if (x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height) continue;
      await page.mouse.click(x, y);
      if (await page.locator('.details').count()) {
        return page.locator('#details-title').textContent();
      }
    }
  }
  throw new Error('no node found near that point');
}

const commands = {
  help: async () =>
    Object.entries(HELP)
      .map(([cmd, text]) => `  ${cmd.padEnd(34)} ${text}`)
      .join('\n'),
  nav: async (path = '/') => {
    const url = new URL(path, BASE);
    url.searchParams.set('automation', '1');
    await page.goto(url.href);
    await page.getByLabel('Title, DOI, or OpenAlex ID').waitFor();
    return page.url();
  },
  build: async (...words) => {
    const id = words.join(' ');
    if (!id) throw new Error('usage: build <DOI or OpenAlex ID>');
    await page.getByLabel('Title, DOI, or OpenAlex ID').fill(id);
    await page.getByRole('button', { name: 'Go' }).click();
    await waitForBuild();
    return `${await shown()}${(await status()) ? ` | ${await status()}` : ''}`;
  },
  start: async (...words) => {
    await page.getByLabel('Title, DOI, or OpenAlex ID').fill(words.join(' '));
    await page.getByRole('button', { name: 'Go' }).click();
    return 'started (not waiting)';
  },
  progress: async () => {
    const list = page.getByRole('list', { name: 'Loading progress' });
    if (!(await list.count())) return 'idle';
    return (await list.locator('li').allInnerTexts())
      .map((t) => t.replace(/\n+/g, ' | '))
      .join(' || ');
  },
  search: async (...words) => {
    await page.getByLabel('Title, DOI, or OpenAlex ID').fill(words.join(' '));
    await page.getByRole('button', { name: 'Go' }).click();
    const list = page.getByRole('list', { name: 'Search results' });
    await list.waitFor({ timeout: 60000 });
    const titles = await list.locator('.result-title').allTextContents();
    return titles.map((t, i) => `\n  ${i + 1}. ${t}`).join('');
  },
  pick: async (n = '1') => {
    const list = page.getByRole('list', { name: 'Search results' });
    await list
      .getByRole('button')
      .nth(Number(n) - 1)
      .click();
    await waitForBuild();
    return shown();
  },
  set: async (...words) => {
    const [label, value] = words.join(' ').split(/\s*=\s*/);
    if (!label || value === undefined) throw new Error('usage: set <label> = <value>');
    const field = page.getByLabel(label, { exact: false }).first();
    const { tag, type } = await field.evaluate((el) => ({ tag: el.tagName, type: el.type }));
    if (tag === 'SELECT') await field.selectOption(value);
    else if (type === 'checkbox') await field.setChecked(/^(on|true|yes|1)$/i.test(value));
    else await field.fill(value);
    return `${label} = ${value}`;
  },
  select: async (kind = 'anchor', n = '1') => {
    if (!['anchor', 'citing', 'cited'].includes(kind))
      throw new Error('usage: select anchor|citing|cited [n]');
    return selectByKind(kind, Number(n));
  },
  'select-title': async (...words) => selectByTitle(words.join(' ')),
  'select-at': async (fx = '0.5', fy = '0.5') => selectNear(Number(fx), Number(fy)),
  expand: async () => {
    if (await page.getByRole('button', { name: 'Expanded' }).count()) {
      throw new Error('selected node is already expanded');
    }
    await page.getByRole('button', { name: /Expand citing/ }).click();
    await page.getByRole('button', { name: 'Expanded' }).waitFor({ timeout: 60000 });
    await page.waitForTimeout(3000);
    return shown();
  },
  reanchor: async () => {
    const button = page.getByRole('button', { name: 'Make this the anchor' });
    if (!(await button.count())) throw new Error('select a node other than the anchor first');
    const title = await page.locator('#details-title').textContent();
    await button.click();
    await waitForBuild();
    return `${title} | ${await shown()}`;
  },
  details: async () => {
    const panel = page.locator('.details');
    if (!(await panel.count())) throw new Error('nothing selected');
    return (await panel.innerText()).replace(/\n+/g, ' | ').slice(0, 600);
  },
  click: async (...name) => {
    await page
      .getByRole('button', { name: name.join(' ') })
      .first()
      .click();
    return name.join(' ');
  },
  theme: async (scheme) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(500);
    return scheme;
  },
  viewport: async (w, h) => {
    await page.setViewportSize({ width: Number(w), height: Number(h) });
    await page.waitForTimeout(800);
    return `${w}x${h}`;
  },
  wait: async (ms = '1000') => {
    await page.waitForTimeout(Number(ms));
    return `${ms}ms`;
  },
  screenshot: async (name = `shot-${Date.now()}`, full) => {
    const path = resolve(OUT, `${name}.png`);
    await page.screenshot({ path, fullPage: full === 'full' });
    return path;
  },
  eval: async (...js) => JSON.stringify(await page.evaluate(js.join(' '))),
  errors: async () => (errors.length ? errors.join('\n  ') : 'none'),
  quit: async () => {
    await browser.close();
    process.exit(0);
  },
};

const HELP = {
  'nav [path]': 'Open the app (default /)',
  'build <DOI|OpenAlex ID>': 'Build a graph from an ID; waits for build + layout settle',
  'search <query>': 'Search by title; lists numbered results',
  'start <DOI|OpenAlex ID>': 'Start a build without waiting (to watch progress)',
  progress: 'Print the loading-progress cards (or idle)',
  'pick [n]': 'Build from search result n (default 1)',
  'set <label> = <value>':
    'Fill an input/select/slider by label, e.g. set Cited depth = 2; checkboxes take on/off',
  'select [anchor|citing|cited] [n]':
    'Select the nth visible node of that kind (top-left first), via the automation hook',
  'select-title <text>': 'Select the visible node whose title contains <text>',
  'select-at [fx fy]': 'Click the node nearest a canvas point (fractions, default 0.5 0.5)',
  details: 'Print the details panel text',
  expand: 'Click Expand on the selected node and wait',
  reanchor: 'Make the selected node the anchor; waits for the rebuild + settle',
  'click <button name>': 'Click a button by accessible name',
  'theme light|dark': 'Emulate color scheme',
  'viewport <w> <h>': 'Resize, e.g. viewport 390 844',
  'wait [ms]': 'Sleep',
  'screenshot [name] [full]': 'Save out/<name>.png (full = whole page)',
  'eval <js>': 'Evaluate JS in the page, print JSON',
  errors: 'Console/page errors so far',
  quit: 'Close the browser and exit',
};

const rl = createInterface({ input: process.stdin });
console.log(`ready ${BASE} (shots: ${OUT})`);
for await (const line of rl) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  if (!cmd || cmd.startsWith('#')) continue;
  const run = commands[cmd];
  if (!run) {
    console.log(`error unknown command: ${cmd} (try help)`);
    continue;
  }
  try {
    console.log(`ok ${cmd}: ${await run(...args)}`);
  } catch (err) {
    console.log(`error ${cmd}: ${err.message.split('\n')[0]}`);
  }
}
await browser.close();
