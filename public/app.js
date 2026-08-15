/**
 * UI Peeper front end.
 *
 * Two ways to show a page, chosen per site rather than per preference:
 *   live  — a real <iframe> at each breakpoint width, scaled to fit the pane
 *   shots — server-rendered full-page PNGs, which work on every site
 *
 * The server's /api/probe tells us which is possible before we try, so a site
 * that refuses embedding drops straight to screenshots instead of showing the
 * blank white box a blocked iframe leaves behind.
 */

const els = {
  form: document.getElementById('url-form'),
  input: document.getElementById('url-input'),
  loadBtn: document.getElementById('load-btn'),
  captureBtn: document.getElementById('capture-btn'),
  zipBtn: document.getElementById('zip-btn'),
  modeLive: document.getElementById('mode-live'),
  modeShots: document.getElementById('mode-shots'),
  chips: document.getElementById('chips'),
  addChip: document.getElementById('add-chip'),
  status: document.getElementById('status'),
  panes: document.getElementById('panes'),
  empty: document.getElementById('empty'),
  examples: document.getElementById('examples'),
};

const state = {
  breakpoints: [],
  limits: { minWidth: 240, maxWidth: 3840, maxBreakpoints: 6, jobTtlMinutes: 15 },
  url: null,
  framable: false,
  frameReason: '',
  mode: 'live',
  job: null,
  busy: false,
};

/** width -> the DOM bits for that pane, so iframes survive re-renders. */
const panes = new Map();
let pollTimer = null;

/* ------------------------------------------------------------------- helpers */

function setStatus(message, kind = '') {
  els.status.textContent = message;
  els.status.className = `status${kind ? ` ${kind}` : ''}`;
}

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error pages fall through to the generic message below */
  }
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
  return body;
}

const fmtBytes = (n) =>
  n == null ? '' : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/* -------------------------------------------------------------------- chips */

function renderChips() {
  els.chips.replaceChildren();

  for (const bp of state.breakpoints) {
    const chip = document.createElement('div');
    chip.className = 'chip';

    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(bp.width);
    input.min = String(state.limits.minWidth);
    input.max = String(state.limits.maxWidth);
    input.setAttribute('aria-label', `${bp.label} width in pixels`);
    input.addEventListener('change', () => commitWidth(bp, input));

    const unit = document.createElement('span');
    unit.textContent = 'px';

    chip.append(input, unit);

    if (state.breakpoints.length > 1) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.title = `Remove ${bp.width}px`;
      remove.setAttribute('aria-label', `Remove the ${bp.width}px breakpoint`);
      remove.addEventListener('click', () => {
        state.breakpoints = state.breakpoints.filter((b) => b !== bp);
        afterBreakpointChange();
      });
      chip.append(remove);
    }

    els.chips.append(chip);
  }

  els.addChip.disabled = state.breakpoints.length >= state.limits.maxBreakpoints;
}

function commitWidth(bp, input) {
  const { minWidth, maxWidth } = state.limits;
  const next = Math.round(Number(input.value));

  if (!Number.isFinite(next) || next < minWidth || next > maxWidth) {
    input.value = String(bp.width);
    setStatus(`Widths must be between ${minWidth} and ${maxWidth}px.`, 'error');
    return;
  }
  if (state.breakpoints.some((b) => b !== bp && b.width === next)) {
    input.value = String(bp.width);
    setStatus(`${next}px is already in the list.`, 'error');
    return;
  }

  bp.width = next;
  bp.id = `bp-${next}`;
  // "Mobile" stays "Mobile" when retuned to 390px; an unnamed 500px chip just
  // tracks its own width.
  bp.label = bp.named ? bp.label : `${next}px`;
  afterBreakpointChange();
}

/**
 * Widths changed, so any existing capture no longer describes what is on screen.
 * Live panes can just re-lay out; screenshots have to be retaken.
 */
function afterBreakpointChange() {
  state.breakpoints.sort((a, b) => a.width - b.width);
  state.job = null;
  stopPolling();
  renderChips();
  syncPanes();
  render();
  if (state.url && state.mode === 'shots') capture();
}

/* -------------------------------------------------------------------- panes */

function buildPane(bp) {
  const root = document.createElement('section');
  root.className = 'pane';

  const head = document.createElement('div');
  head.className = 'pane-head';

  const label = document.createElement('span');
  label.className = 'label';

  const dim = document.createElement('span');
  dim.className = 'dim';

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  const meta = document.createElement('span');
  meta.className = 'dim';

  const download = document.createElement('a');
  download.className = 'icon-btn';
  download.textContent = 'PNG';
  download.setAttribute('role', 'button');
  download.hidden = true;

  head.append(label, dim, spacer, meta, download);

  const stage = document.createElement('div');
  stage.className = 'stage';

  const viewport = document.createElement('div');
  viewport.className = 'viewport';

  const iframe = document.createElement('iframe');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('loading', 'lazy');
  iframe.title = `Live preview at ${bp.width} pixels`;
  viewport.append(iframe);

  const shot = document.createElement('img');
  shot.className = 'shot';
  shot.alt = '';
  shot.hidden = true;

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.hidden = true;

  stage.append(viewport, shot, overlay);
  root.append(head, stage);

  return { root, label, dim, meta, download, stage, viewport, iframe, shot, overlay, src: null };
}

/** Reconciles pane elements against state.breakpoints, reusing matching widths. */
function syncPanes() {
  const wanted = new Set(state.breakpoints.map((bp) => bp.width));

  for (const [width, pane] of panes) {
    if (!wanted.has(width)) {
      pane.root.remove();
      panes.delete(width);
    }
  }

  for (const bp of state.breakpoints) {
    if (!panes.has(bp.width)) panes.set(bp.width, buildPane(bp));
  }

  // Re-append in width order; appending an existing node moves it without
  // reloading the iframe inside it.
  for (const bp of state.breakpoints) {
    els.panes.append(panes.get(bp.width).root);
  }
}

function overlayCard({ title, body, code, spinner, action }) {
  const card = document.createElement('div');
  card.className = 'overlay-card';

  if (spinner) {
    const s = document.createElement('div');
    s.className = 'spinner';
    card.append(s);
  }
  if (title) {
    const h = document.createElement('h3');
    h.textContent = title;
    card.append(h);
  }
  if (body) {
    const p = document.createElement('p');
    p.textContent = body;
    if (code) {
      p.append(document.createElement('br'));
      const c = document.createElement('code');
      c.textContent = code;
      p.append(c);
    }
    card.append(p);
  }
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    card.append(btn);
  }
  return card;
}

function render() {
  // Panes exist as soon as breakpoints do, but showing them before a URL is
  // loaded puts three blank white stages above the empty state.
  const hasPanes = Boolean(state.url) && state.breakpoints.length > 0;
  els.empty.hidden = hasPanes;
  els.panes.hidden = !hasPanes;

  els.modeLive.setAttribute('aria-pressed', String(state.mode === 'live'));
  els.modeShots.setAttribute('aria-pressed', String(state.mode === 'shots'));
  els.modeLive.disabled = Boolean(state.url) && !state.framable;

  els.captureBtn.disabled = !state.url || state.busy;
  els.zipBtn.disabled = !state.job || !state.job.shots.some((s) => s.status === 'done');

  for (const bp of state.breakpoints) {
    renderPane(bp, panes.get(bp.width));
  }
  layout();
}

function renderPane(bp, pane) {
  if (!pane) return;

  pane.label.textContent = bp.label;
  pane.dim.textContent = `${bp.width}px`;
  pane.overlay.replaceChildren();
  pane.overlay.hidden = true;
  pane.meta.textContent = '';
  pane.download.hidden = true;

  const live = state.mode === 'live';
  pane.viewport.hidden = !live;
  pane.shot.hidden = live;
  pane.stage.classList.toggle('scrolls', !live);

  if (!state.url) {
    pane.iframe.removeAttribute('src');
    pane.src = null;
    return;
  }

  if (live) {
    if (!state.framable) {
      pane.overlay.hidden = false;
      pane.overlay.append(
        overlayCard({
          title: 'This site blocks embedding',
          body: state.frameReason,
          action: { label: 'Capture screenshots instead', onClick: () => setMode('shots') },
        }),
      );
      return;
    }
    if (pane.src !== state.url) {
      pane.iframe.src = state.url;
      pane.src = state.url;
    }
    return;
  }

  renderShot(bp, pane);
}

function renderShot(bp, pane) {
  const shot = state.job?.shots.find((s) => s.width === bp.width);

  if (!shot || shot.status === 'pending' || shot.status === 'running') {
    pane.shot.removeAttribute('src');
    pane.overlay.hidden = false;
    pane.overlay.append(
      overlayCard({
        spinner: true,
        title: shot ? 'Rendering' : 'Waiting',
        body: shot ? `Loading the page at ${bp.width}px.` : 'Queued for capture.',
      }),
    );
    return;
  }

  if (shot.status === 'error') {
    pane.shot.removeAttribute('src');
    pane.overlay.hidden = false;
    pane.overlay.append(
      overlayCard({ title: 'Could not capture', body: shot.error ?? 'Unknown error.' }),
    );
    return;
  }

  const src = `/api/capture/${state.job.id}/shot/${shot.id}`;
  if (pane.shot.getAttribute('src') !== src) pane.shot.src = src;
  pane.shot.alt = `${state.url} rendered at ${bp.width} pixels wide`;
  // Never upscale: a 375px capture shown at 500px would look soft and lie about
  // how crisp the site actually is.
  pane.shot.style.maxWidth = `${bp.width}px`;

  pane.meta.textContent = [
    shot.height ? `${shot.height}px tall` : '',
    fmtBytes(shot.bytes),
    shot.truncated ? 'clipped' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  pane.download.hidden = false;
  pane.download.href = `${src}?download=1`;
  pane.download.setAttribute('download', shot.filename);
  pane.download.title = `Download ${shot.filename}`;
}

/**
 * Scales each live iframe so a real `bp.width` viewport fits the pane.
 * The iframe is sized in true CSS pixels and then transformed, which is what
 * makes the page inside believe it is on a 375px device.
 */
function layout() {
  if (state.mode !== 'live') return;

  for (const bp of state.breakpoints) {
    const pane = panes.get(bp.width);
    if (!pane) continue;

    const { clientWidth: w, clientHeight: h } = pane.stage;
    if (!w || !h) continue;

    const scale = Math.min(1, w / bp.width);
    pane.viewport.style.width = `${bp.width}px`;
    pane.viewport.style.height = `${h / scale}px`;
    pane.viewport.style.transform = `scale(${scale})`;
    pane.viewport.style.left = `${Math.max(0, (w - bp.width * scale) / 2)}px`;
  }
}

/* ------------------------------------------------------------------ actions */

function setMode(mode) {
  if (mode === 'live' && state.url && !state.framable) return;
  state.mode = mode;
  render();
  if (mode === 'shots' && state.url && !state.job) capture();
}

async function load(rawUrl) {
  const value = rawUrl.trim();
  if (!value) return;

  stopPolling();
  state.busy = true;
  state.job = null;
  state.url = null;
  setStatus('Checking that site…');
  render();

  let probe;
  try {
    probe = await api('/api/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: value }),
    });
  } catch (err) {
    state.busy = false;
    setStatus(err.message, 'error');
    render();
    return;
  }

  state.url = probe.finalUrl;
  state.framable = probe.framable;
  state.frameReason = probe.reason;
  state.busy = false;
  els.input.value = probe.finalUrl;

  syncPanes();

  if (probe.framable) {
    state.mode = 'live';
    setStatus('Live preview — each pane scrolls on its own.');
    render();
  } else {
    state.mode = 'shots';
    setStatus(`${probe.reason} — switching to screenshots.`, 'warn');
    render();
    capture();
  }
}

async function capture() {
  if (!state.url || state.busy) return;

  stopPolling();
  state.busy = true;
  state.mode = 'shots';
  setStatus('Rendering every breakpoint…');
  render();

  try {
    state.job = await api('/api/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: state.url,
        breakpoints: state.breakpoints.map(({ width, label }) => ({ width, label })),
      }),
    });
    render();
    poll();
  } catch (err) {
    state.busy = false;
    setStatus(err.message, 'error');
    render();
  }
}

function poll() {
  pollTimer = setTimeout(async () => {
    if (!state.job) return;
    try {
      const job = await api(`/api/capture/${state.job.id}`);
      state.job = job;
      render();

      if (job.status === 'running') {
        poll();
        return;
      }

      state.busy = false;
      const ok = job.shots.filter((s) => s.status === 'done').length;
      const failed = job.shots.length - ok;
      setStatus(
        failed === 0
          ? `Captured ${ok} breakpoint${ok === 1 ? '' : 's'}. Files expire in ${state.limits.jobTtlMinutes} minutes.`
          : `Captured ${ok} of ${job.shots.length}; ${failed} failed.`,
        failed === 0 ? '' : 'warn',
      );
      render();
    } catch (err) {
      state.busy = false;
      setStatus(err.message, 'error');
      render();
    }
  }, 800);
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

/* --------------------------------------------------------------------- wiring */

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  load(els.input.value);
});

els.captureBtn.addEventListener('click', () => capture());
els.modeLive.addEventListener('click', () => setMode('live'));
els.modeShots.addEventListener('click', () => setMode('shots'));

els.zipBtn.addEventListener('click', () => {
  if (state.job) window.location.href = `/api/capture/${state.job.id}/archive.zip`;
});

els.addChip.addEventListener('click', () => {
  const widest = state.breakpoints.at(-1)?.width ?? 375;
  let next = Math.min(state.limits.maxWidth, widest + 320);
  while (state.breakpoints.some((b) => b.width === next) && next < state.limits.maxWidth) next += 1;
  if (state.breakpoints.some((b) => b.width === next)) return;

  state.breakpoints.push({ id: `bp-${next}`, label: `${next}px`, width: next });
  afterBreakpointChange();
});

els.examples.addEventListener('click', (event) => {
  const url = event.target.closest('button')?.dataset.url;
  if (!url) return;
  els.input.value = url;
  load(url);
});

new ResizeObserver(() => layout()).observe(els.panes);
window.addEventListener('resize', layout);

(async function init() {
  try {
    const config = await api('/api/config');
    state.limits = config.limits;
    state.breakpoints = config.defaultBreakpoints.map((bp) => ({ ...bp, named: true }));
  } catch {
    state.breakpoints = [
      { id: 'bp-375', label: 'Mobile', width: 375, named: true },
      { id: 'bp-768', label: 'Tablet', width: 768, named: true },
      { id: 'bp-1440', label: 'Desktop', width: 1440, named: true },
    ];
    setStatus('Could not reach the server for configuration.', 'error');
  }

  renderChips();
  syncPanes();
  render();

  const fromQuery = new URLSearchParams(window.location.search).get('url');
  if (fromQuery) {
    els.input.value = fromQuery;
    load(fromQuery);
  }
})();
