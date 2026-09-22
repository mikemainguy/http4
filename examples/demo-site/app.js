// Field Notes: the demo page's own script. It renders the JSON content and the
// protocol panel. It contains no protocol code: it only reads the public page
// API that /http4/auto.js puts on window.http4 (report, onReport, ready), the
// browser's Resource Timing, and ordinary fetch(). Every request, including
// the ones below, is routed by the Service Worker, not by this file.

const http4 = window.http4; // undefined when the page is loaded without HTTP4 (e.g. over /h3/)
const page = location.pathname.endsWith("text-only.html") ? "text-only.html" : "index.html";
const onH3 = location.protocol === "https:" && location.pathname.startsWith("/h3/");
const mode = onH3 ? "h3" : !http4 ? "network" : http4.disabled ? "network" : http4.controlled ? "http4" : "first-visit";

const MODE_LABEL = {
  http4: "HTTP4",
  "first-visit": "HTTP4 (first visit: reload to switch on)",
  network: "Plain HTTP",
  h3: "HTTP/3",
};

// ---- content ---------------------------------------------------------------

async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function renderContent() {
  const [articles, comments, stats] = await Promise.all([
    getJSON("api/articles.json"),
    getJSON("api/comments.json"),
    getJSON("api/stats.json"),
  ]);
  document.getElementById("articles").innerHTML = articles
    .map((a) => `<li><strong>${escape(a.title)}</strong><span class="meta">${a.date} · ${a.minutes} min read</span></li>`)
    .join("");
  document.getElementById("comments").innerHTML = comments
    .map((c) => `<li><strong>${escape(c.who)}</strong>${escape(c.text)}</li>`)
    .join("");
  document.getElementById("stats").textContent =
    `${stats.walks} walks · ${stats.kilometres} km · ${stats.photographs} photographs`;
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

// ---- mode switcher -------------------------------------------------------------

async function renderModes() {
  const nav = document.getElementById("modes");
  const back = new URLSearchParams(location.search).get("back");
  const tcpBase = onH3 ? back ?? "" : location.origin;
  const links = [
    { mode: "http4", href: `${tcpBase}/${page}` },
    { mode: "network", href: `${tcpBase}/${page}?http4=off` },
  ];
  const h3 = onH3 ? location.href : await findH3();
  if (h3) links.push({ mode: "h3", href: onH3 ? location.href : `${h3}${page}?back=${encodeURIComponent(location.origin)}` });

  const current = mode === "first-visit" ? "http4" : mode;
  nav.innerHTML = links
    .map((l) => (l.mode === current
      ? `<span class="current">${MODE_LABEL[l.mode]}</span>`
      : `<a href="${escape(l.href)}">${MODE_LABEL[l.mode]}</a>`))
    .join("");
  if (mode === "first-visit") nav.insertAdjacentHTML("beforeend", `<span class="hint">first visit: this load used the network</span>`);
  if (!h3 && !onH3) {
    nav.insertAdjacentHTML("beforeend", `<span class="hint" title="Serve with -h3 and launch Chrome with the flags in README.md">HTTP/3: not available</span>`);
  }
}

// HTTP/3 needs `http4d serve -h3` and Chrome launched with flags (README.md).
// Probe it after the page has loaded, so the check never competes with it.
async function findH3() {
  try {
    const cfg = await (await fetch("/config.json", { cache: "no-store" })).json();
    if (!cfg.h3Url) return null;
    const url = `${cfg.h3Url}api/stats.json?probe=${Date.now()}`;
    // Read the body: the Resource Timing entry only exists once the response has ended.
    await (await fetch(url, { cache: "no-store" })).arrayBuffer();
    const entry = performance.getEntriesByName(url)[0];
    return entry?.nextHopProtocol === "h3" ? cfg.h3Url : null;
  } catch {
    return null;
  }
}

// ---- protocol panel ------------------------------------------------------------

const panel = document.getElementById("panel");
const rows = new Map(); // url → { timing, report }
let scheduled = false;
let collapsed = false;

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    void render();
  });
}

// Everything the panel shows arrives as events; nothing polls the page or the network.
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (e.name.includes("probe=")) continue; // our own HTTP/3 probe
    const row = rows.get(e.name) ?? {};
    row.timing = e;
    rows.set(e.name, row);
  }
  schedule();
}).observe({ type: "resource", buffered: true });

if (http4) {
  http4.onReport((r) => {
    const row = rows.get(r.url) ?? {};
    row.report = r;
    rows.set(r.url, row);
    schedule();
  });
  void http4.report().then((all) => {
    for (const r of all) {
      const row = rows.get(r.url) ?? {};
      row.report ??= r;
      rows.set(r.url, row);
    }
    schedule();
  });
}

function transportOf(row) {
  if (row.report) return row.report.transport === "platform" ? "network" : row.report.transport;
  // Chrome's memory cache can serve a reload's images and stylesheet itself;
  // those never reach the worker or the network.
  if (row.timing?.deliveryType === "cache" && !row.timing.workerStart) return "cache";
  const proto = row.timing?.nextHopProtocol;
  return proto === "h3" ? "h3" : "network";
}

function bytesOf(row) {
  if (row.report && row.report.transport === "http4" && row.report.bytes != null) return row.report.bytes;
  return row.timing?.encodedBodySize || row.timing?.transferSize || 0;
}

async function render() {
  const list = [...rows.entries()]
    .filter(([, r]) => r.timing)
    .sort(([, a], [, b]) => a.timing.responseEnd - b.timing.responseEnd);
  const end = Math.max(1, ...list.map(([, r]) => r.timing.responseEnd));
  let http4Bytes = 0;
  let eligibleBytes = 0;
  for (const [, r] of list) {
    const t = r.report?.transport;
    if (t === "http4" || t === "fallback") eligibleBytes += bytesOf(r);
    if (t === "http4") http4Bytes += bytesOf(r);
  }
  const stats = http4 ? (await http4.ready).client?.stats : undefined;
  const ms = (v) => (v == null ? "–" : `${v.toFixed(1)} ms`);
  const kb = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} MB` : `${(v / 1e3).toFixed(1)} KB`);

  panel.className = `panel${collapsed ? " collapsed" : ""}`;
  panel.innerHTML = `
    <div class="head"><b>${MODE_LABEL[mode]}</b>
      <span>${list.length} resources · ${eligibleBytes ? `${((100 * http4Bytes) / eligibleBytes).toFixed(0)}% of bytes over HTTP4` : "no HTTP4 bytes"}</span>
      <span>${collapsed ? "▲" : "▼"}</span></div>
    <div class="body">
      <dl>
        <dt>srtt</dt><dd>${ms(stats?.srttMs)}</dd><dt>min RTT</dt><dd>${ms(stats?.minRttMs)}</dd>
        <dt>grant budget</dt><dd>${stats ? kb(stats.budget) : "–"}</dd><dt>BDP</dt><dd>${stats?.bdpBytes ? kb(stats.bdpBytes) : "–"}</dd>
        <dt>resends</dt><dd>${stats?.resendsSent ?? "–"}</dd><dt>recoveries</dt><dd>${stats?.recoveries ?? "–"}</dd>
      </dl>
      <table>
        <thead><tr><th class="num">#</th><th>resource</th><th>via</th><th class="num">size</th><th class="num">done</th><th>timeline</th></tr></thead>
        <tbody>${list.map(([url, r], i) => {
          const t = r.timing;
          const via = transportOf(r);
          const left = (100 * t.startTime) / end;
          const width = Math.max(1, (100 * (t.responseEnd - t.startTime)) / end);
          return `<tr><td class="num">${i + 1}</td><td class="name" title="${escape(url)}">${escape(new URL(url).pathname.split("/").pop() || url)}</td>
            <td class="t-${via}">${via}</td><td class="num">${kb(bytesOf(r))}</td><td class="num">${t.responseEnd.toFixed(0)}</td>
            <td style="width:30%"><div class="bar t-${via}" style="margin-left:${left}%;width:${width}%"></div></td></tr>`;
        }).join("")}</tbody>
      </table>
    </div>`;
}

panel.addEventListener("click", (e) => {
  if (e.target.closest(".head")) {
    collapsed = !collapsed;
    schedule();
  }
});

// ---- for tests: resolves once everything the page loads has loaded ----------------

window.__demo = {
  mode,
  done: Promise.all([
    renderContent(),
    new Promise((r) => (document.readyState === "complete" ? r() : addEventListener("load", r, { once: true }))),
  ]).then(() => document.fonts.ready).then(() => {
    void renderModes();
    schedule();
  }),
};
