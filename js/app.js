/**
 * Single-page UI — hash routes, all data from /api/* (requires server.py).
 */

const app = document.getElementById("app");
const footerStatus = document.getElementById("footer-status");
const tooltipEl = document.getElementById("tooltip");

// ───────────────────────────────────────────── highlight.js YAML helper ──────

/**
 * Apply syntax highlighting to a <code> element containing YAML text.
 * Falls back gracefully to plain monospace if hljs isn't available.
 */
function highlightYamlCode(codeEl) {
  if (!codeEl) return;
  const raw = codeEl.textContent;
  codeEl.classList.add("language-yaml");
  const hljs = globalThis.hljs;
  if (!hljs || typeof hljs.highlight !== "function") {
    codeEl.classList.add("yaml-plain");
    return;
  }
  try {
    const res = hljs.highlight(raw, { language: "yaml", ignoreIllegals: true });
    codeEl.innerHTML = res.value;
    codeEl.classList.add("hljs");
  } catch (err) {
    console.warn("YAML highlight skipped:", err);
    codeEl.textContent = raw;
    codeEl.classList.add("yaml-plain");
  }
}

// ───────────────────────────────────────────────────────── tooltip state ──────

let tooltipTimer = null;
let tooltipFrozen = false;   // true = clicked to pin; tooltip is selectable

function _positionTooltip(x, y) {
  const pad = 14;
  let left = x + pad;
  let top  = y + pad;
  const rect = tooltipEl.getBoundingClientRect();
  if (left + rect.width  > window.innerWidth  - 8) left = window.innerWidth  - rect.width  - 8;
  if (top  + rect.height > window.innerHeight - 8) top  = y - rect.height - pad;
  tooltipEl.style.left = `${Math.max(8, left)}px`;
  tooltipEl.style.top  = `${Math.max(8, top)}px`;
}

function showTooltipYaml(yamlText, x, y) {
  if (tooltipFrozen) return;
  if (tooltipTimer) clearTimeout(tooltipTimer);
  tooltipEl.hidden = false;
  tooltipEl.classList.remove("frozen");
  tooltipEl.innerHTML = '<pre class="tooltip-pre"><code class="language-yaml"></code></pre>';
  const code = tooltipEl.querySelector("code");
  code.textContent = yamlText || "# (empty)";
  highlightYamlCode(code);
  _positionTooltip(x, y);
}

function freezeTooltip(yamlText, x, y) {
  // Show (or re-show) and lock in place; make selectable
  if (tooltipTimer) clearTimeout(tooltipTimer);
  tooltipFrozen = true;
  tooltipEl.hidden = false;
  tooltipEl.classList.add("frozen");
  tooltipEl.innerHTML = '<div class="tooltip-pin-bar">📌 click anywhere to unpin</div><pre class="tooltip-pre"><code class="language-yaml"></code></pre>';
  const code = tooltipEl.querySelector("code");
  code.textContent = yamlText || "# (empty)";
  highlightYamlCode(code);
  _positionTooltip(x, y);
}

function unfreezeTooltip() {
  tooltipFrozen = false;
  tooltipEl.classList.remove("frozen");
  tooltipEl.hidden = true;
  tooltipEl.innerHTML = "";
}

function hideTooltip() {
  if (tooltipFrozen) return;
  if (tooltipTimer) clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(() => {
    tooltipEl.hidden = true;
    tooltipEl.innerHTML = "";
  }, 120);
}

// Follow mouse only when not frozen
document.addEventListener("mousemove", (e) => {
  if (!tooltipFrozen && !tooltipEl.hidden) {
    _positionTooltip(e.clientX, e.clientY);
  }
});

// Click anywhere outside the frozen tooltip → unfreeze
document.addEventListener("click", (e) => {
  if (tooltipFrozen && !tooltipEl.contains(e.target)) {
    unfreezeTooltip();
  }
});

// Escape key → unfreeze
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && tooltipFrozen) unfreezeTooltip();
});

// ───────────────────────────────────────────────────────────── API fetch ──────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { Accept: "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

/** POST JSON and parse JSON; throws Error with server message on failure. */
async function apiPostJson(path, jsonBody) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jsonBody),
  });
  const ct = res.headers.get("content-type") || "";
  let data;
  try {
    data = ct.includes("application/json") ? await res.json() : { raw: await res.text() };
  } catch {
    data = {};
  }
  if (!res.ok) {
    const msg = data.error || data.raw || res.statusText;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(data));
  }
  if (data && data.ok === false && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

function setRadioByValue(groupName, value) {
  document.querySelectorAll(`input[name="${groupName}"]`).forEach((r) => {
    r.checked = r.value === value;
  });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

// ──────────────────────────────────────────────────────────── Home page ──────

async function renderHome() {
  let meta = {}, hasData = false, pid = null, cfg = {};
  try {
    const [m, c] = await Promise.all([api("/api/meta"), api("/api/config")]);
    hasData = m.has_data;
    meta = m.meta || {};
    pid = m.pid ?? null;
    cfg = c;
  } catch {
    footerStatus.innerHTML =
      'Cannot reach API. From this folder run <code>./run.sh</code> and open <code>http://127.0.0.1:8765/</code>';
  }

  const last = meta.last_scan_iso || "never";
  const errList = meta.scan_errors || [];
  const errHtml = errList.length
    ? `<div class="error-banner"><strong>Last scan issues</strong><pre class="scan-log">${esc(errList.join("\n"))}</pre></div>`
    : "";

  const counts = meta.customer_counts_by_cloud || {};
  const countLine = Object.keys(counts).length
    ? `<p style="font-size:0.9rem;color:var(--muted);">Customers by cloud (last scan): ${esc(
        Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · ")
      )}</p>`
    : "";

  const pidLine = pid
    ? `<p class="pid-line">Server PID: <strong>${pid}</strong>
         &nbsp;—&nbsp; to stop from terminal: <code>kill ${pid}</code>
         &nbsp;or&nbsp; <button type="button" class="btn btn-danger" id="btn-stop">Stop server</button>
       </p>`
    : "";

  app.innerHTML = `
    <div class="panel">
      <h2>Scan customers</h2>
      <p style="color:var(--muted);font-size:0.9rem;">
        Reads <code>custom_values_*.yaml</code> / <code>.yml</code> from the customers root
        (AWS/ and Azure/ subdirectories), merges with base <code>values.yaml</code>,
        stores in <code>data/analyzer.db</code>. Sources are never modified.
      </p>

      <div class="path-config">
        <h3 style="margin:0 0 0.5rem;font-size:0.9rem;">Source paths</h3>
        <label>Customers root (parent of AWS/, Azure/)
          <input type="text" id="cfg-cust-root" value="${esc(cfg.customers_root || "")}" />
        </label>
        <label>Base values.yaml
          <input type="text" id="cfg-base-vals" value="${esc(cfg.base_values || "")}" />
        </label>
        <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
          <button type="button" class="btn" id="btn-save-cfg">Save paths</button>
          <span id="cfg-msg" style="font-size:0.8rem;color:var(--muted);"></span>
        </div>
      </div>

      ${errHtml}
      ${countLine}
      <p>Last scan: <strong>${esc(last)}</strong></p>
      <div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;">
        <button type="button" class="btn btn-primary" id="btn-scan">Scan customers</button>
        <a class="btn" href="#/dashboard" data-route style="text-decoration:none;">Open matrix</a>
      </div>
      <pre class="scan-log hidden" id="scan-out"></pre>
      ${pidLine}
    </div>
  `;

  document.getElementById("btn-save-cfg")?.addEventListener("click", async () => {
    const cr  = document.getElementById("cfg-cust-root").value.trim();
    const bv  = document.getElementById("cfg-base-vals").value.trim();
    const msg = document.getElementById("cfg-msg");
    if (!cr || !bv) { msg.textContent = "Both paths are required."; msg.style.color = "var(--off)"; return; }
    try {
      const r = await api("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customers_root: cr, base_values: bv }),
      });
      if (r.ok) {
        msg.textContent = `Saved. Next scan will use these paths.`;
        msg.style.color = "var(--on)";
      } else {
        msg.textContent = r.error || "Failed"; msg.style.color = "var(--off)";
      }
    } catch (e) { msg.textContent = String(e.message || e); msg.style.color = "var(--off)"; }
  });

  document.getElementById("btn-scan")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-scan");
    const out  = document.getElementById("scan-out");
    btn.disabled = true;
    out.classList.remove("hidden");
    out.textContent = "Scanning…";
    try {
      const r = await api("/api/scan", { method: "POST" });
      const lines = [
        `Customers scanned: ${r.customers_scanned}`,
        `Service keys:      ${r.service_keys?.length ?? 0}`,
        `Root:              ${r.customers_root || ""}`,
        `Base:              ${r.base_values_path || ""}`,
      ];
      if (r.errors?.length) lines.push("Errors:", ...r.errors);
      out.textContent = lines.join("\n");
      footerStatus.textContent = "Scan complete.";
    } catch (e) {
      out.textContent = String(e.message || e);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-stop")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!confirm(`Stop the server (PID ${pid})?`)) return;
    btn.disabled = true;
    btn.textContent = "Stopping…";
    try {
      await api("/api/stop", { method: "POST" });
      app.innerHTML = `<div class="panel"><p>Server stopped. Close this tab or restart with <code>./run.sh</code>.</p></div>`;
      footerStatus.textContent = "Server stopped.";
    } catch {
      app.innerHTML = `<div class="panel"><p>Server stopped (connection closed as expected).</p></div>`;
    }
  });

  if (hasData) footerStatus.textContent = `Data loaded. Last scan: ${last}`;
}

// ──────────────────────────────────────────── Shared cloud / filter utils ──────

function filterList(items, q) {
  if (!q.trim()) return items;
  const low = q.toLowerCase();
  return items.filter((x) => x.toLowerCase().includes(low));
}

/** "AWS/absa" → "AWS";  "Azure/foo" → "Azure";  "flat" → "" */
function cloudOf(name) {
  const i = name.indexOf("/");
  return i > 0 ? name.slice(0, i) : "";
}

/**
 * Strip the "Cloud/" prefix when a specific cloud is selected.
 * "AWS/absa" + cloud="AWS"  → "absa"
 * "AWS/absa" + cloud="both" → "AWS/absa"
 */
function displayCustomerName(name, cloud) {
  if (cloud && cloud !== "both") {
    const i = name.indexOf("/");
    if (i > 0) return name.slice(i + 1);
  }
  return name;
}

/** Returns HTML for AWS / Azure / Both radio group. `groupName` must be unique per page. */
function cloudRadioHTML(groupName) {
  return `<span class="cloud-radio-group" role="group" aria-label="Cloud">
    <label class="radio-lbl"><input type="radio" name="${groupName}" value="both" checked /> Both</label>
    <label class="radio-lbl"><input type="radio" name="${groupName}" value="AWS" /> AWS</label>
    <label class="radio-lbl"><input type="radio" name="${groupName}" value="Azure" /> Azure</label>
  </span>`;
}

function getCloud(groupName) {
  return document.querySelector(`input[name="${groupName}"]:checked`)?.value || "both";
}

/** Core / Other / All — Core = `core_service_key` enabled for customer. */
function coreRadioHTML(groupName) {
  return `<span class="core-radio-group" role="group" aria-label="Customer segment">
    <label class="radio-lbl"><input type="radio" name="${groupName}" value="all" checked /> All</label>
    <label class="radio-lbl"><input type="radio" name="${groupName}" value="core" /> Core</label>
    <label class="radio-lbl"><input type="radio" name="${groupName}" value="other" /> Other</label>
  </span>`;
}

function getSegmentMode(groupName) {
  return document.querySelector(`input[name="${groupName}"]:checked`)?.value || "all";
}

/**
 * @param {string[]} customers
 * @param {Record<string, boolean>} customerCore
 * @param {"all"|"core"|"other"} mode
 */
function filterCustomersBySegment(customers, customerCore, mode) {
  if (!mode || mode === "all") return customers;
  return customers.filter((c) => {
    const isCore = customerCore[c] === true;
    if (mode === "core") return isCore;
    return !isCore;
  });
}

// ──────────────────────────────────────────────── Matrix / dashboard page ──────

function isCellGreen(byService, svc, cust) {
  return byService[svc]?.[cust]?.enabled === true;
}

/**
 * When exactly one service row remains → filter customers by green/red on that row.
 * When exactly one customer column remains → filter services by green/red on that column.
 */
function applyAxisColorFilter(fsBase, fcBase, byService, mode) {
  if (!mode) return { services: fsBase, customers: fcBase };

  const singleRow = fsBase.length === 1 && fcBase.length > 1;
  const singleCol = fcBase.length === 1 && fsBase.length > 1;

  if (singleRow) {
    const s0 = fsBase[0];
    const pred = mode === "green" ? (c) => isCellGreen(byService, s0, c) : (c) => !isCellGreen(byService, s0, c);
    return { services: fsBase, customers: fcBase.filter(pred) };
  }
  if (singleCol) {
    const c0 = fcBase[0];
    const pred = mode === "green" ? (s) => isCellGreen(byService, s, c0) : (s) => !isCellGreen(byService, s, c0);
    return { services: fsBase.filter(pred), customers: fcBase };
  }
  return { services: fsBase, customers: fcBase };
}

async function renderDashboard() {
  let data;
  try {
    data = await api("/api/dashboard");
  } catch (e) {
    app.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`;
    return;
  }

  const {
    customer_names: customers = [],
    service_keys: services = [],
    matrix = [],
    customer_core: customerCore = {},
    core_service_key: coreKey = "clingine",
  } = data;

  const coreTitle = `Core = customers with ${coreKey} enabled: true; Other = not.`;

  app.innerHTML = `
    <div class="legend">
      <span><i class="pill on"></i> <strong>Green</strong> — <code>enabled: true</code></span>
      <span><i class="pill off"></i> <strong>Red</strong> — anything else; hover for YAML &nbsp;·&nbsp; <em>click to pin / unpin</em></span>
    </div>
    <div class="filters filters-matrix-toolbar">
      <label>Filter services <input type="search" id="f-svc" placeholder="substring…" autocomplete="off" /></label>
      <label>Filter customers <input type="search" id="f-cust" placeholder="substring…" autocomplete="off" /></label>
      <span class="filter-toolbar-cluster" title="Cloud">
        ${cloudRadioHTML("mx-cloud")}
      </span>
      <span class="filter-toolbar-cluster" title="${esc(coreTitle)}">
        ${coreRadioHTML("mx-core")}
      </span>
      <label id="f-color-wrap" class="hidden">Filter
        <select id="f-color">
          <option value="">all</option>
          <option value="red">red</option>
          <option value="green">green</option>
        </select>
      </label>
      <a class="btn" id="mx-csv" href="/api/export/matrix.csv?segment=all" download="matrix.csv">Download CSV</a>
    </div>
    <p class="matrix-toolbar-hint"><span class="muted-label">Segment</span> — ${esc(coreTitle)}</p>
    <div class="matrix-wrap" id="matrix-wrap"></div>
  `;

  const wrap       = document.getElementById("matrix-wrap");
  const fCust      = document.getElementById("f-cust");
  const fSvc       = document.getElementById("f-svc");
  const fColor     = document.getElementById("f-color");
  const fColorWrap = document.getElementById("f-color-wrap");
  const mxCsv      = document.getElementById("mx-csv");

  const byService = Object.fromEntries(matrix.map((r) => [r.service, r.by_customer]));

  function syncCsvHref() {
    const seg = getSegmentMode("mx-core");
    mxCsv.href = `/api/export/matrix.csv?segment=${encodeURIComponent(seg)}`;
  }

  function paint() {
    const cloud = getCloud("mx-cloud");
    const seg   = getSegmentMode("mx-core");
    const svcQ  = fSvc.value;
    const custQ = fCust.value;

    syncCsvHref();

    // Cloud → segment → text filters (segment uses precomputed scan flags; fast on the client)
    const cloudCustomers = customers.filter((c) => cloud === "both" || cloudOf(c) === cloud);
    const segCustomers   = filterCustomersBySegment(cloudCustomers, customerCore, seg);
    const fsBase = filterList(services, svcQ);
    const fcBase = filterList(segCustomers, custQ);

    const otherFiltersUsed =
      svcQ.trim() !== "" || custQ.trim() !== "" || cloud !== "both" || seg !== "all";
    const singleRow = fsBase.length === 1 && fcBase.length > 1;
    const singleCol = fcBase.length === 1 && fsBase.length > 1;
    const showColor = otherFiltersUsed && (singleRow || singleCol);

    if (!showColor) {
      fColorWrap.classList.add("hidden");
      fColor.value = "";
    } else {
      fColorWrap.classList.remove("hidden");
    }

    const { services: fs, customers: fc } = applyAxisColorFilter(
      fsBase, fcBase, byService, showColor ? fColor.value : ""
    );

    const tipById = new Map();
    let tipSeq = 0;

    if (fs.length === 0 || fc.length === 0) {
      wrap.innerHTML = '<p style="padding:1rem;color:var(--muted);">No rows to show for the current filters.</p>';
      return;
    }

    const thead = `<tr>
      <th class="corner">Service</th>
      ${fc.map((c) => {
        const label = displayCustomerName(c, cloud);
        return `<th class="customer-h" title="${esc(c)}"><span>${esc(label)}</span></th>`;
      }).join("")}
    </tr>`;

    const rows = fs.map((svc) => {
      const bc = byService[svc] || {};
      const cells = fc.map((c) => {
        const cell  = bc[c] || {};
        const green = cell.enabled === true;
        const yaml  = cell.yaml || "";
        const tid   = String(tipSeq++);
        tipById.set(tid, yaml);
        return `<td class="cell" data-tip-id="${tid}"><span class="pill ${green ? "on" : "off"}"></span></td>`;
      }).join("");
      return `<tr><td class="service-name" title="${esc(svc)}">${esc(svc)}</td>${cells}</tr>`;
    });

    wrap.innerHTML = `<table class="matrix"><thead>${thead}</thead><tbody>${rows.join("")}</tbody></table>`;

    wrap.querySelectorAll("td.cell").forEach((td) => {
      const yaml = tipById.get(td.getAttribute("data-tip-id")) ?? "";
      td.addEventListener("mouseenter", (ev) => showTooltipYaml(yaml, ev.clientX, ev.clientY));
      td.addEventListener("mouseleave", hideTooltip);
      td.addEventListener("click", (ev) => {
        ev.stopPropagation();
        tooltipFrozen ? unfreezeTooltip() : freezeTooltip(yaml, ev.clientX, ev.clientY);
      });
    });
  }

  fSvc.addEventListener("input", paint);
  fCust.addEventListener("input", paint);
  fColor.addEventListener("change", paint);
  document.querySelectorAll('input[name="mx-cloud"]').forEach((r) => r.addEventListener("change", paint));
  document.querySelectorAll('input[name="mx-core"]').forEach((r) => r.addEventListener("change", paint));
  paint();
}

// ─────────────────────────────────────────────────────── Customers page ──────

async function renderCustomers() {
  let list = [];
  try { list = await api("/api/customers"); }
  catch (e) { app.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`; return; }

  app.innerHTML = `
    <div class="panel" style="max-width:36rem;">
      <h2>Customers (${list.length})</h2>
      <div class="filters filters-matrix-toolbar">
        <span class="filter-toolbar-cluster" title="Core / Other (from last scan)">
          ${coreRadioHTML("cust-core")}
        </span>
        <label>Filter <input type="search" id="f-list" placeholder="name…" autocomplete="off" /></label>
      </div>
      <ul class="customer-list" id="cust-ul"></ul>
    </div>
  `;

  const ul  = document.getElementById("cust-ul");
  const inp = document.getElementById("f-list");

  function paint() {
    const seg = getSegmentMode("cust-core");
    let rows = list;
    if (seg === "core") rows = rows.filter((x) => x.core);
    else if (seg === "other") rows = rows.filter((x) => !x.core);
    const items = filterList(rows.map((x) => x.name), inp.value);
    ul.innerHTML = items
      .map((name) => `<li><a href="#/customer/${encodeURIComponent(name)}" data-route>${esc(name)}</a></li>`)
      .join("");
  }
  inp.addEventListener("input", paint);
  document.querySelectorAll('input[name="cust-core"]').forEach((r) => r.addEventListener("change", paint));
  paint();
}

// ──────────────────────────────────────────────────────── Services page ──────

async function renderServices() {
  let payload;
  try { payload = await api("/api/services"); }
  catch (e) { app.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`; return; }

  const list = payload.services || [];
  const coreKey = payload.core_service_key || "clingine";

  app.innerHTML = `
    <div class="panel" style="max-width:36rem;">
      <h2>Services (${list.length})</h2>
      <p class="matrix-toolbar-hint" style="margin-top:0;"><span class="muted-label">Segment</span> — Core = service appears in at least one <em>Core</em> customer (${esc(coreKey)} on); Other = at least one <em>Other</em> customer.</p>
      <div class="filters filters-matrix-toolbar">
        <span class="filter-toolbar-cluster" title="Limit by customer segment">
          ${coreRadioHTML("svc-core")}
        </span>
        <label>Filter <input type="search" id="f-svc-list" placeholder="service key…" autocomplete="off" /></label>
      </div>
      <ul class="customer-list" id="svc-ul"></ul>
    </div>
  `;

  const ul  = document.getElementById("svc-ul");
  const inp = document.getElementById("f-svc-list");

  function paint() {
    const seg = getSegmentMode("svc-core");
    let rows = list;
    if (seg === "core") rows = rows.filter((x) => x.in_core);
    else if (seg === "other") rows = rows.filter((x) => x.in_other);
    const items = filterList(rows.map((x) => x.name), inp.value);
    ul.innerHTML = items
      .map((name) => `<li><a href="#/service/${encodeURIComponent(name)}" data-route>${esc(name)}</a></li>`)
      .join("");
  }
  inp.addEventListener("input", paint);
  document.querySelectorAll('input[name="svc-core"]').forEach((r) => r.addEventListener("change", paint));
  paint();
}

// ─────────────────────────────────────────────────── Customer detail page ──────

async function renderCustomer(name) {
  let row;
  try { row = await api(`/api/customer?name=${encodeURIComponent(name)}`); }
  catch (e) { app.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`; return; }

  const filesLine = (row.source_files || []).map((f) => f.name).join(", ");

  app.innerHTML = `
    <div class="panel" style="max-width:100%;">
      <h2>${esc(row.name)}</h2>
      <p class="files">Sources: ${esc(filesLine || "—")}</p>
      <p style="font-size:0.85rem;color:var(--muted);">Merged values (base + overlays). Read-only YAML.</p>
      <pre class="yaml-view"><code class="language-yaml" id="cust-yaml"></code></pre>
    </div>
  `;

  const code = document.getElementById("cust-yaml");
  code.textContent = row.merged_yaml || "# (empty)";
  highlightYamlCode(code);
}

// ─────────────────────────────────────────────────── Service detail page ──────

async function renderService(name) {
  let row;
  try { row = await api(`/api/service?name=${encodeURIComponent(name)}`); }
  catch (e) { app.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`; return; }

  const allEntries = Object.entries(row.by_customer || {})
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  app.innerHTML = `
    <div class="panel" style="max-width:100%;">
      <h2>${esc(row.name)}</h2>
      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem;">
        <a class="btn btn-primary" href="#/dive/${encodeURIComponent(row.name)}" data-route style="text-decoration:none;">Open in Service Dive</a>
        <span class="cloud-radio-group" role="group" aria-label="Filter">
          <label class="radio-lbl"><input type="radio" name="svc-color" value="all" checked /> All</label>
          <label class="radio-lbl"><input type="radio" name="svc-color" value="green" /> Green</label>
          <label class="radio-lbl"><input type="radio" name="svc-color" value="red" /> Red</label>
        </span>
        <span id="svc-count" style="font-size:0.82rem;color:var(--muted);"></span>
      </div>
      <p style="font-size:0.85rem;color:var(--muted);">Per-customer merged subtree for this service. Read-only YAML. Click a customer name to view their full config.</p>
      <div id="svc-entries"></div>
    </div>
  `;

  const container = document.getElementById("svc-entries");
  const countEl   = document.getElementById("svc-count");

  function paint() {
    const mode = document.querySelector('input[name="svc-color"]:checked')?.value || "all";
    const filtered = mode === "all"
      ? allEntries
      : mode === "green"
        ? allEntries.filter(([, info]) => info.enabled === true)
        : allEntries.filter(([, info]) => info.enabled !== true);

    countEl.textContent = `Showing ${filtered.length} of ${allEntries.length} customers`;
    container.innerHTML = "";

    for (const [cust, info] of filtered) {
      const section = document.createElement("div");
      section.className = "svc-customer-block";

      const h3 = document.createElement("h3");
      h3.className = "svc-cust-head";
      const link = document.createElement("a");
      link.href = `#/customer/${encodeURIComponent(cust)}`;
      link.setAttribute("data-route", "");
      link.textContent = cust;
      link.className = "svc-cust-link";
      h3.appendChild(link);
      section.appendChild(h3);

      const badge = document.createElement("p");
      badge.className = "files";
      badge.textContent = info.enabled ? "● enabled: true (green)" : "○ not enabled: true (red)";
      badge.style.color = info.enabled ? "var(--on)" : "var(--off)";
      section.appendChild(badge);

      const pre  = document.createElement("pre");
      pre.className = "yaml-view";
      const code = document.createElement("code");
      code.className = "language-yaml";
      code.textContent = info.yaml || "# (empty)";
      highlightYamlCode(code);
      pre.appendChild(code);
      section.appendChild(pre);

      container.appendChild(section);
    }
  }

  document.querySelectorAll('input[name="svc-color"]').forEach((r) =>
    r.addEventListener("change", paint)
  );
  paint();
}

// ──────────────────────────────────────────────────────── Service Dive ──────

/**
 * Filter customers to those that have a cell whose key name contains `kvKey`
 * AND whose display / yaml value contains `kvValue`.
 * - Both empty  → no-op (return fc unchanged).
 * - Only kvKey  → keep customers that have that key and it is not missing.
 * - Only kvValue→ keep customers where any key's value contains kvValue.
 * - Both set    → keep customers where the matching key's value contains kvValue.
 */
function filterCustomersByKV(data, fc, kvKey, kvValue) {
  const kLow = kvKey.trim().toLowerCase();
  const vLow = kvValue.trim().toLowerCase();
  if (!kLow && !vLow) return fc;

  return fc.filter((cust) => {
    const matchingRows = kLow
      ? data.matrix.filter((row) => row.key.toLowerCase().includes(kLow))
      : data.matrix;

    return matchingRows.some((row) => {
      const cell = row.by_customer[cust];
      if (!cell || cell.is_missing) return false;
      if (!vLow) return true;                                         // key matched, no value constraint
      return cell.display.toLowerCase().includes(vLow)
          || cell.yaml.toLowerCase().includes(vLow);
    });
  });
}

/**
 * Client-side modal recomputation for the visible subset of customers.
 * Returns { modal_val, modal_pct } based on `display` values of fc.
 */
function recomputeModal(rowData, fc) {
  const nonMissing = fc
    .map((c) => rowData.by_customer[c])
    .filter((cell) => cell && !cell.is_missing)
    .map((cell) => cell.display);
  if (!nonMissing.length) return { modal_val: null, modal_pct: 0 };
  const counts = {};
  for (const v of nonMissing) counts[v] = (counts[v] || 0) + 1;
  const [modal_val, modal_count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { modal_val, modal_pct: parseFloat(((modal_count / fc.length) * 100).toFixed(1)) };
}

/** Repopulate Service Dive diff dropdowns; keep valid values; avoid A === B when possible. */
function syncDiveDiffSelects(pool, cloud) {
  const selA = document.getElementById("dive-diff-a");
  const selB = document.getElementById("dive-diff-b");
  if (!selA || !selB) return;
  const va = selA.value;
  const vb = selB.value;
  const opt = (c) =>
    `<option value="${esc(c)}">${esc(displayCustomerName(c, cloud))}</option>`;
  const head = '<option value="">— choose —</option>';
  selA.innerHTML = head + pool.map(opt).join("");
  selB.innerHTML = head + pool.map(opt).join("");
  if (pool.includes(va)) selA.value = va;
  else selA.value = pool[0] || "";
  if (pool.includes(vb)) selB.value = vb;
  else selB.value = pool.length >= 2 ? pool[1] : pool[0] || "";
  if (selA.value && selA.value === selB.value && pool.length >= 2) {
    const other = pool.find((c) => c !== selA.value);
    if (other) selB.value = other;
  }
}

async function runServiceDiveYamlDiff(modeArg) {
  const svc = document.getElementById("dive-select")?.value;
  const a = document.getElementById("dive-diff-a")?.value;
  const b = document.getElementById("dive-diff-b")?.value;
  const panel = document.getElementById("dive-yaml-diff-panel");
  if (!svc || !panel) return;

  const mode =
    modeArg === "diff" || modeArg === "all"
      ? modeArg
      : (panel.querySelector('input[name="yaml-diff-scope"]:checked')?.value || "diff");

  if (!a || !b || a === b) {
    panel.classList.remove("hidden");
    panel.innerHTML = `<div class="panel yaml-diff-inner"><p class="error-banner">Select two different customers.</p></div>`;
    return;
  }
  panel.classList.remove("hidden");
  panel.innerHTML = `<div class="panel yaml-diff-inner"><p style="color:var(--muted)">Generating diff…</p></div>`;
  try {
    const res = await api(
      `/api/service-yaml-diff?service=${encodeURIComponent(svc)}&customer_a=${encodeURIComponent(a)}&customer_b=${encodeURIComponent(b)}&mode=${encodeURIComponent(mode)}`,
    );
    if (res.error) {
      panel.innerHTML = `<div class="panel yaml-diff-inner"><p class="error-banner">${esc(res.error)}</p></div>`;
      return;
    }
    const m = res.mode === "all" ? "all" : "diff";
    panel.innerHTML = `<div class="panel yaml-diff-inner yaml-diff-surface">
      <div class="yaml-diff-toolbar">
        <span><strong>YAML diff</strong> — <code>${esc(res.service)}</code></span>
        <span class="yaml-diff-scope-wrap" role="group" aria-label="YAML scope">
          <span class="yaml-diff-scope-label">View</span>
          <span class="cloud-radio-group yaml-diff-scope-radios">
            <label class="radio-lbl"><input type="radio" name="yaml-diff-scope" value="diff" ${m === "diff" ? "checked" : ""} /> only-Diff</label>
            <label class="radio-lbl"><input type="radio" name="yaml-diff-scope" value="all" ${m === "all" ? "checked" : ""} /> all</label>
          </span>
        </span>
        <span class="yaml-diff-labels"><span>${esc(res.left)}</span> · <span>${esc(res.right)}</span></span>
        <button type="button" class="btn" id="dive-yaml-diff-close">Close</button>
      </div>
      <p class="yaml-diff-mode-hint">${m === "all" ? "Full YAML on both sides; changed lines use diff colors." : "Hunks with a few lines of context (default)."}</p>
      <div class="yaml-diff-table-wrap">${res.html}</div>
    </div>`;
    document.getElementById("dive-yaml-diff-close")?.addEventListener("click", () => {
      panel.classList.add("hidden");
      panel.innerHTML = "";
    });
  } catch (e) {
    panel.innerHTML = `<div class="panel yaml-diff-inner"><p class="error-banner">${esc(String(e))}</p></div>`;
  }
}

async function renderServiceDive(preselect = "") {
  let payload;
  try { payload = await api("/api/services"); }
  catch (e) { app.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`; return; }

  const coreKey = payload.core_service_key || "clingine";
  const serviceList = payload.services || [];
  const names = serviceList.map((s) => s.name);
  const diveCoreTitle = `Core = ${coreKey} enabled: true; Other = not.`;
  let diveData = null;

  app.innerHTML = `
    <div style="max-width:100%;">
      <div class="panel dive-header-panel">
        <h2>Service Dive</h2>
        <p style="color:var(--muted);font-size:0.9rem;">
          Select a service to explore its 2nd-level config keys across all customers.
          Hover over a cell for the full YAML subtree &nbsp;·&nbsp; click to pin.
        </p>
        <div class="filters">
          <label>Service
            <select id="dive-select" style="min-width:16rem;">
              <option value="">— choose a service —</option>
              ${names.map((n) => `<option value="${esc(n)}" ${n === preselect ? "selected" : ""}>${esc(n)}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="dive-filter-mode-wrap hidden" id="dive-filter-mode-wrap">
          <span class="muted-label">Filters</span>
          <span class="dive-filter-mode-radios" role="group" aria-label="Filter mode">
            <label class="radio-lbl"><input type="radio" name="dive-filter-mode" value="manual" checked /> Manual</label>
            <label class="radio-lbl"><input type="radio" name="dive-filter-mode" value="ai" /> AI (Gemini)</label>
          </span>
          <span id="dive-gemini-status-pill" class="dive-gemini-pill hidden" title="Whether a Gemini API key is available on the server"></span>
        </div>
        <div class="filters dive-subfilters filters-matrix-toolbar hidden" id="dive-subfilters">
          <div class="dive-manual-only filters" id="dive-manual-text-filters">
            <label>Filter keys
              <input type="search" id="dive-fkey" placeholder="key name…" autocomplete="off" />
            </label>
            <label id="dive-fcust-wrap">Filter customers
              <input type="search" id="dive-fcust" placeholder="customer…" autocomplete="off" />
            </label>
          </div>
          <span class="filter-toolbar-cluster" title="Cloud">
            ${cloudRadioHTML("dive-cloud")}
          </span>
          <span class="filter-toolbar-cluster" title="${esc(diveCoreTitle)}">
            ${coreRadioHTML("dive-core")}
          </span>
          <span class="dive-legend">
            <span class="dive-pill modal">■</span>&nbsp;= same as majority &nbsp;&nbsp;
            <span class="dive-pill outlier">■</span>&nbsp;= different &nbsp;&nbsp;
            <span class="dive-pill missing">—</span>&nbsp;= not set
          </span>
        </div>
        <p class="matrix-toolbar-hint dive-segment-hint hidden" id="dive-seg-hint"><span class="muted-label">Segment</span> — ${esc(diveCoreTitle)}</p>
        <div class="dive-ai-panel hidden" id="dive-ai-panel">
          <label class="dive-ai-label" for="dive-ai-query">Describe what to show</label>
          <textarea id="dive-ai-query" class="dive-ai-textarea" rows="3" placeholder="Example: Azure customers where replicas is 3, or any row mentioning 500m CPU…" autocomplete="off"></textarea>
          <div class="dive-ai-actions">
            <button type="button" class="btn btn-primary" id="dive-ai-apply">Interpret &amp; apply</button>
            <span id="dive-ai-busy" class="hidden muted">Working…</span>
          </div>
          <p id="dive-ai-explanation" class="dive-ai-explanation" hidden></p>
          <details class="dive-gemini-settings">
            <summary>API key &amp; key file path</summary>
            <p class="dive-gemini-hint">Your key stays on this machine. Saved keys are written to <code>data/.gemini_api_key</code> (under <code>data/</code>, not committed). By default the app uses free-tier-friendly models (<code>gemini-2.5-flash-lite</code>, then <code>gemini-2.5-flash</code>, then <code>gemini-3-flash-preview</code>) and skips deprecated 2.0. Override with env <code>GEMINI_MODEL</code> or a comma list <code>GEMINI_MODEL_FALLBACKS</code>. You can also set <code>GEMINI_API_KEY</code> / <code>GOOGLE_API_KEY</code> or key-file env vars, or store a path below.</p>
            <div class="dive-gemini-key-row">
              <input type="password" id="dive-gemini-key-input" placeholder="AIza… (Google AI API key)" autocomplete="off" class="dive-gemini-input" />
              <button type="button" class="btn" id="dive-gemini-key-save">Save key</button>
            </div>
            <div class="dive-gemini-key-row">
              <input type="text" id="dive-gemini-keyfile" placeholder="/absolute/path/to/gemini_api_key.txt" class="dive-gemini-input dive-gemini-keyfile" autocomplete="off" />
              <button type="button" class="btn" id="dive-gemini-keyfile-save">Save path</button>
            </div>
            <button type="button" class="btn" id="dive-gemini-key-clear">Remove saved key file</button>
          </details>
        </div>
        <div class="kv-row dive-manual-only hidden" id="dive-kv-row">
          <span class="kv-label">Filter key+value</span>
          <input type="search" id="dive-kvkey" placeholder="key…" autocomplete="off" class="kv-input" />
          <span class="kv-contains">contains</span>
          <input type="search" id="dive-kvval" placeholder="value…" autocomplete="off" class="kv-input kv-val" />
        </div>
        <div class="dive-diff-row dive-manual-only hidden" id="dive-diff-row">
          <label class="dive-diff-check">
            <input type="checkbox" id="dive-diff-mode" autocomplete="off" /> Diff customers
          </label>
          <span id="dive-diff-picks" class="dive-diff-picks hidden">
            <label>Customer A
              <select id="dive-diff-a"></select>
            </label>
            <label>Customer B
              <select id="dive-diff-b"></select>
            </label>
            <button type="button" class="btn" id="dive-yaml-diff-btn">YamlDiff</button>
          </span>
        </div>
      </div>
      <div id="dive-body" style="margin-top:0.75rem;"></div>
    </div>
  `;

  const selectEl   = document.getElementById("dive-select");
  const subfilters = document.getElementById("dive-subfilters");
  const kvRow      = document.getElementById("dive-kv-row");
  const bodyEl     = document.getElementById("dive-body");
  let subfiltersWired = false;

  function setDiveFilterMode(mode) {
    const manual = mode === "manual";
    document.querySelectorAll(".dive-manual-only").forEach((el) => {
      el.classList.toggle("hidden", !manual);
    });
    const ai = document.getElementById("dive-ai-panel");
    if (ai) ai.classList.toggle("hidden", manual);
  }

  async function refreshDiveGeminiStatus() {
    const pill = document.getElementById("dive-gemini-status-pill");
    try {
      const s = await api("/api/gemini/status");
      if (pill) {
        pill.classList.remove("hidden");
        pill.textContent = s.configured ? "Gemini key available" : "No Gemini key on server";
        pill.classList.toggle("dive-gemini-pill-warn", !s.configured);
      }
    } catch {
      if (pill) {
        pill.classList.remove("hidden");
        pill.textContent = "Could not read API status";
        pill.classList.add("dive-gemini-pill-warn");
      }
    }
  }

  function paintDive() {
    if (!diveData) return;
    const matrixMount = document.getElementById("dive-matrix-mount");
    if (!matrixMount) return;
    const cloud   = getCloud("dive-cloud");
    const segment = getSegmentMode("dive-core");
    const keyQ    = document.getElementById("dive-fkey")?.value   || "";
    const custQ   = document.getElementById("dive-fcust")?.value  || "";
    const kvKey   = document.getElementById("dive-kvkey")?.value  || "";
    const kvValue = document.getElementById("dive-kvval")?.value  || "";
    const diffMode = document.getElementById("dive-diff-mode")?.checked;

    let pool = diveData.customers.filter((c) => cloud === "both" || cloudOf(c) === cloud);
    pool = filterCustomersBySegment(pool, diveData.customer_core || {}, segment);
    if (diffMode) syncDiveDiffSelects(pool, cloud);

    const diffA = document.getElementById("dive-diff-a")?.value?.trim() || "";
    const diffB = document.getElementById("dive-diff-b")?.value?.trim() || "";

    renderDiveTable(
      diveData,
      {
        cloud,
        segment,
        keyQ,
        custQ: diffMode ? "" : custQ,
        kvKey,
        kvValue,
        diffMode,
        diffCustomerA: diffA,
        diffCustomerB: diffB,
      },
      matrixMount,
    );
  }

  selectEl.addEventListener("change", () => loadDive(selectEl.value));

  async function loadDive(serviceName) {
    if (!serviceName) {
      bodyEl.innerHTML = "";
      subfilters.classList.add("hidden");
      kvRow.classList.add("hidden");
      document.getElementById("dive-seg-hint")?.classList.add("hidden");
      document.getElementById("dive-diff-row")?.classList.add("hidden");
      document.getElementById("dive-filter-mode-wrap")?.classList.add("hidden");
      document.getElementById("dive-ai-panel")?.classList.add("hidden");
      const mRadio = document.querySelector('input[name="dive-filter-mode"][value="manual"]');
      if (mRadio) mRadio.checked = true;
      setDiveFilterMode("manual");
      return;
    }
    bodyEl.innerHTML = '<p style="padding:0.5rem 0;color:var(--muted);">Loading…</p>';
    try {
      diveData = await api(`/api/service-dive?service=${encodeURIComponent(serviceName)}`);
      bodyEl.innerHTML = `
        <div id="dive-matrix-mount"></div>
        <div id="dive-yaml-diff-panel" class="yaml-diff-panel hidden" aria-live="polite"></div>
      `;
      subfilters.classList.remove("hidden");
      kvRow.classList.remove("hidden");
      document.getElementById("dive-seg-hint")?.classList.remove("hidden");
      document.getElementById("dive-diff-row")?.classList.remove("hidden");
      document.getElementById("dive-filter-mode-wrap")?.classList.remove("hidden");
      const mRadio = document.querySelector('input[name="dive-filter-mode"][value="manual"]');
      if (mRadio) mRadio.checked = true;
      setDiveFilterMode("manual");
      void refreshDiveGeminiStatus();
      const dm = document.getElementById("dive-diff-mode");
      if (dm) dm.checked = false;
      document.getElementById("dive-diff-picks")?.classList.add("hidden");
      document.getElementById("dive-fcust-wrap")?.classList.remove("hidden");
      const yp = document.getElementById("dive-yaml-diff-panel");
      if (yp) {
        yp.classList.add("hidden");
        yp.innerHTML = "";
        yp.addEventListener("change", (e) => {
          if (e.target?.name === "yaml-diff-scope") runServiceDiveYamlDiff(e.target.value);
        });
      }
      if (!subfiltersWired) {
        subfiltersWired = true;
        ["dive-fkey", "dive-fcust", "dive-kvkey", "dive-kvval"].forEach((id) =>
          document.getElementById(id).addEventListener("input", paintDive)
        );
        document.querySelectorAll('input[name="dive-cloud"]').forEach((r) =>
          r.addEventListener("change", paintDive)
        );
        document.querySelectorAll('input[name="dive-core"]').forEach((r) =>
          r.addEventListener("change", paintDive)
        );
        document.getElementById("dive-diff-mode")?.addEventListener("change", () => {
          const on = document.getElementById("dive-diff-mode")?.checked;
          document.getElementById("dive-diff-picks")?.classList.toggle("hidden", !on);
          document.getElementById("dive-fcust-wrap")?.classList.toggle("hidden", !!on);
          const ypanel = document.getElementById("dive-yaml-diff-panel");
          if (ypanel) {
            ypanel.classList.add("hidden");
            ypanel.innerHTML = "";
          }
          paintDive();
        });
        document.getElementById("dive-diff-a")?.addEventListener("change", paintDive);
        document.getElementById("dive-diff-b")?.addEventListener("change", paintDive);
        document.getElementById("dive-yaml-diff-btn")?.addEventListener("click", () => {
          runServiceDiveYamlDiff();
        });
        document.querySelectorAll('input[name="dive-filter-mode"]').forEach((r) =>
          r.addEventListener("change", () => {
            const mode = document.querySelector('input[name="dive-filter-mode"]:checked')?.value || "manual";
            setDiveFilterMode(mode);
          }),
        );
        document.getElementById("dive-ai-apply")?.addEventListener("click", async () => {
          const q = document.getElementById("dive-ai-query")?.value?.trim();
          const expl = document.getElementById("dive-ai-explanation");
          const busy = document.getElementById("dive-ai-busy");
          if (!q || !diveData?.service) {
            if (expl) {
              expl.hidden = false;
              expl.textContent = "Enter a description first.";
              expl.classList.add("dive-ai-explanation-error");
            }
            return;
          }
          busy?.classList.remove("hidden");
          if (expl) expl.classList.remove("dive-ai-explanation-error");
          try {
            const res = await apiPostJson("/api/service-dive/nl-filter", {
              service: diveData.service,
              query: q,
            });
            const f = res.filter || {};
            const fk = document.getElementById("dive-fkey");
            const fc = document.getElementById("dive-fcust");
            const kk = document.getElementById("dive-kvkey");
            const kv = document.getElementById("dive-kvval");
            if (fk) fk.value = f.keyQ || "";
            if (fc) fc.value = f.custQ || "";
            if (kk) kk.value = f.kvKey || "";
            if (kv) kv.value = f.kvValue || "";
            setRadioByValue("dive-cloud", f.cloud || "both");
            setRadioByValue("dive-core", f.segment || "all");
            if (expl) {
              expl.hidden = !f.explanation;
              expl.textContent = f.explanation || "";
              expl.classList.remove("dive-ai-explanation-error");
            }
            paintDive();
          } catch (err) {
            if (expl) {
              expl.hidden = false;
              expl.textContent = String(err?.message || err);
              expl.classList.add("dive-ai-explanation-error");
            }
          } finally {
            busy?.classList.add("hidden");
          }
        });
        document.getElementById("dive-gemini-key-save")?.addEventListener("click", async () => {
          const inp = document.getElementById("dive-gemini-key-input");
          const k = inp?.value?.trim();
          if (!k) return;
          try {
            await apiPostJson("/api/gemini/settings", { api_key: k });
            inp.value = "";
            await refreshDiveGeminiStatus();
          } catch (err) {
            alert(String(err?.message || err));
          }
        });
        document.getElementById("dive-gemini-keyfile-save")?.addEventListener("click", async () => {
          const inp = document.getElementById("dive-gemini-keyfile");
          const p = inp?.value?.trim() || "";
          try {
            await apiPostJson("/api/gemini/settings", { gemini_key_file: p });
            await refreshDiveGeminiStatus();
          } catch (err) {
            alert(String(err?.message || err));
          }
        });
        document.getElementById("dive-gemini-key-clear")?.addEventListener("click", async () => {
          try {
            await apiPostJson("/api/gemini/settings", { clear_saved_key: true });
            await refreshDiveGeminiStatus();
          } catch (err) {
            alert(String(err?.message || err));
          }
        });
      }
      paintDive();
    } catch (e) {
      document.getElementById("dive-diff-row")?.classList.add("hidden");
      bodyEl.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`;
    }
  }

  if (preselect && names.includes(preselect)) loadDive(preselect);
}

/**
 * Render the filtered dive table into `container` (matrix mount only).
 * Recomputes modal values for the visible customer subset so colors are always
 * meaningful even when cloud / text filters narrow the view.
 */
function renderDiveTable(
  data,
  {
    cloud = "both",
    segment = "all",
    keyQ = "",
    custQ = "",
    kvKey = "",
    kvValue = "",
    diffMode = false,
    diffCustomerA = "",
    diffCustomerB = "",
  },
  container,
) {
  const { service, customers, matrix } = data;
  const customerCore = data.customer_core || {};

  let fc;

  if (diffMode) {
    let pool = customers.filter((c) => cloud === "both" || cloudOf(c) === cloud);
    pool = filterCustomersBySegment(pool, customerCore, segment);
    const a = diffCustomerA;
    const b = diffCustomerB;
    if (!a || !b || a === b) {
      container.innerHTML =
        '<div class="panel dive-matrix-placeholder"><p style="color:var(--muted);">Check <strong>Diff customers</strong> and choose two different customers.</p></div>';
      return;
    }
    if (!pool.includes(a) || !pool.includes(b)) {
      container.innerHTML =
        '<div class="panel dive-matrix-placeholder"><p style="color:var(--muted);">Those customers are not in the current cloud/segment filter.</p></div>';
      return;
    }
    fc = [a, b];
    fc = filterCustomersByKV(data, fc, kvKey, kvValue);
    if (fc.length < 2) {
      container.innerHTML =
        '<div class="panel dive-matrix-placeholder"><p style="color:var(--muted);">Key+value filter removed one of the two customers; clear or relax it.</p></div>';
      return;
    }
  } else {
    fc = customers.filter((c) => cloud === "both" || cloudOf(c) === cloud);
    fc = filterCustomersBySegment(fc, customerCore, segment);
    fc = fc.filter((c) => !custQ.trim() || c.toLowerCase().includes(custQ.toLowerCase()));
    fc = filterCustomersByKV(data, fc, kvKey, kvValue);
  }

  const fs = matrix.filter((row) => !keyQ.trim() || row.key.toLowerCase().includes(keyQ.toLowerCase()));

  if (!fs.length || !fc.length) {
    container.innerHTML =
      '<div class="panel dive-matrix-placeholder"><p style="color:var(--muted);">No data for the current filters.</p></div>';
    return;
  }

  const tipById = new Map();
  let tipSeq = 0;

  const thead = `<tr>
    <th class="corner dive-corner">Key <span class="dive-corner-sub">uniform%</span></th>
    ${fc.map((c) => {
      const label = displayCustomerName(c, cloud);
      return `<th class="customer-h" title="${esc(c)}"><span>${esc(label)}</span></th>`;
    }).join("")}
  </tr>`;

  const rows = fs.map((rowData) => {
    const { key, by_customer } = rowData;

    // Recompute modal for currently visible customers
    const { modal_val, modal_pct } = recomputeModal(rowData, fc);
    const badgeClass = modal_pct >= 80 ? "pct-high" : modal_pct >= 50 ? "pct-mid" : "pct-low";

    const cells = fc.map((c) => {
      const cell       = by_customer[c] || {};
      const is_missing = cell.is_missing;
      const is_modal   = !is_missing && cell.display === modal_val;
      const cls        = is_missing ? "missing" : is_modal ? "modal" : "outlier";
      const tid        = String(tipSeq++);
      tipById.set(tid, cell.yaml || "");
      return `<td class="dive-cell ${cls}" data-tip-id="${tid}"><span class="dive-val">${esc(cell.display || "—")}</span></td>`;
    }).join("");

    return `<tr>
      <td class="service-name dive-key-col">
        <span class="dive-key-name">${esc(key)}</span>
        <span class="dive-pct ${badgeClass}" title="${modal_pct}% share same value">${modal_pct}%</span>
      </td>
      ${cells}
    </tr>`;
  });

  container.innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix dive-matrix">
        <thead>${thead}</thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>
    <p class="dive-footer">
      ${fs.length} keys &nbsp;·&nbsp; ${fc.length} customer${fc.length === 1 ? "" : "s"}
      ${diffMode ? "&nbsp;·&nbsp; <strong>diff</strong>" : ""}
      ${cloud !== "both" ? `(${esc(cloud)} only)` : ""}
      ${(kvKey || kvValue) ? `&nbsp;·&nbsp; key+val: <em>${esc(kvKey || "*")} ⊇ "${esc(kvValue)}"</em>` : ""}
      &nbsp;·&nbsp; service: <strong>${esc(service)}</strong>
    </p>
  `;

  container.querySelectorAll("td.dive-cell").forEach((td) => {
    const yaml = tipById.get(td.getAttribute("data-tip-id")) ?? "";
    td.addEventListener("mouseenter", (ev) => showTooltipYaml(yaml, ev.clientX, ev.clientY));
    td.addEventListener("mouseleave", hideTooltip);
    td.addEventListener("click", (ev) => {
      ev.stopPropagation();
      tooltipFrozen ? unfreezeTooltip() : freezeTooltip(yaml, ev.clientX, ev.clientY);
    });
  });
}

// ──────────────────────────────────────────────────────── Anomaly page ──────

async function renderAnomaly() {
  app.innerHTML = `
    <div class="panel anomaly-panel">
      <h2>Anomaly Detection</h2>
      <p style="color:var(--muted);font-size:0.9rem;">
        Find customers or services with an unexpectedly low count of enabled or disabled entries.
        Customer segment limits which customers are counted (services mode uses the same set for column totals).
      </p>
      <div class="filters anomaly-filters filters-matrix-toolbar">
        <span class="filter-toolbar-cluster" title="Core / Other customer set">
          ${coreRadioHTML("an-core")}
        </span>
        <label>Find
          <select id="an-entity">
            <option value="customers">customers</option>
            <option value="services">services</option>
          </select>
        </label>
        <label>with less than
          <input type="number" id="an-threshold" value="5" min="0" max="9999" style="min-width:5rem;" />
        </label>
        <label>of
          <select id="an-color">
            <option value="green">enabled / green</option>
            <option value="red">disabled / red</option>
          </select>
        </label>
        <button type="button" class="btn btn-primary" id="an-run">Find</button>
      </div>
      <div id="an-results"></div>
    </div>
  `;

  const btn     = document.getElementById("an-run");
  const results = document.getElementById("an-results");

  async function run() {
    const entity    = document.getElementById("an-entity").value;
    const threshold = parseInt(document.getElementById("an-threshold").value, 10) || 0;
    const color     = document.getElementById("an-color").value;
    const segment   = getSegmentMode("an-core");

    btn.disabled = true;
    results.innerHTML = '<p style="color:var(--muted);">Loading…</p>';

    try {
      const data = await api(
        `/api/anomaly?entity=${entity}&threshold=${encodeURIComponent(threshold)}&color=${color}&segment=${encodeURIComponent(segment)}`
      );

      if (!data.length) {
        results.innerHTML = '<p style="color:var(--muted);">No matches found.</p>';
        return;
      }

      const other      = entity === "customers" ? "services" : "customers";
      const colorLabel = color === "green" ? "green (enabled)" : "red (disabled)";
      const pctOf      = (count, total) => total ? `${((count / total) * 100).toFixed(1)}%` : "—";

      const rows = data.map((item) => {
        const href = entity === "customers"
          ? `#/customer/${encodeURIComponent(item.name)}`
          : `#/service/${encodeURIComponent(item.name)}`;
        return `<tr>
          <td><a href="${href}" data-route>${esc(item.name)}</a></td>
          <td class="an-count ${color === "green" ? "an-green" : "an-red"}">${item.count}</td>
          <td class="an-total">${item.total}</td>
          <td class="an-pct">${pctOf(item.count, item.total)}</td>
        </tr>`;
      });

      results.innerHTML = `
        <p style="font-size:0.85rem;color:var(--muted);margin-bottom:0.5rem;">
          ${data.length} ${entity} with fewer than <strong>${threshold}</strong> ${colorLabel} ${other}:
        </p>
        <table class="anomaly-table">
          <thead><tr>
            <th>${entity === "customers" ? "Customer" : "Service"}</th>
            <th title="Count of ${colorLabel} ${other}">${color === "green" ? "Green" : "Red"}</th>
            <th title="Total ${other}">Total</th>
            <th>%</th>
          </tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      `;
    } catch (e) {
      results.innerHTML = `<p class="error-banner">${esc(String(e))}</p>`;
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener("click", run);
  document.querySelectorAll('input[name="an-core"]').forEach((r) => r.addEventListener("change", run));
  run(); // auto-run on load
}

// ──────────────────────────────────────────────────────────── About page ──────

async function renderAbout() {
  let info = {};
  try { info = await api("/api/about"); }
  catch (e) { app.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`; return; }

  const features = (info.features || []).map((f) => `<li>${esc(f)}</li>`).join("");
  const paths = info.source_paths || {};

  app.innerHTML = `
    <div class="panel about-panel">
      <h2>${esc(info.name || "Custom Values Analyzer")}</h2>
      <p class="about-version">v${esc(info.version || "?")}</p>
      <p style="color:var(--muted);font-size:0.9rem;margin-bottom:1rem;">${esc(info.description || "")}</p>

      <h3>Features</h3>
      <ul class="about-features">${features}</ul>

      <h3>Tech</h3>
      <p style="font-size:0.9rem;">${esc(info.tech || "")}</p>

      <h3>Source paths (read-only)</h3>
      <table class="about-paths">
        <tr><td>Customers root</td><td><code>${esc(paths.customers_root || "—")}</code></td></tr>
        <tr><td>Base values</td><td><code>${esc(paths.base_values || "—")}</code></td></tr>
      </table>

      <h3>Versioning</h3>
      <p style="color:var(--muted);font-size:0.9rem;margin-bottom:1rem;">The app version is <code>VERSION</code> in <code>server.py</code>. Each release should bump that string and the <code>?v=</code> query strings (and footer label) in <code>index.html</code> so browsers load updated CSS and JS instead of stale cache.</p>

      <h3>Changelog</h3>
      <ul class="about-changelog">
        <li><strong>1.0.19</strong> — YAML diff panel: <strong>only-Diff</strong> (context hunks) vs <strong>all</strong> (full YAML with diff colors)</li>
        <li><strong>1.0.18</strong> — Service Dive: <strong>Diff customers</strong> mode (two dropdowns, matrix shows only those columns); <strong>YamlDiff</strong> button with side-by-side HTML diff of merged service YAML (<code>difflib.HtmlDiff</code>)</li>
        <li><strong>1.0.17</strong> — Narrower segmented radio controls (cloud / core / service detail) so filter bars fit panel width; toolbar row wraps when needed</li>
        <li><strong>1.0.16</strong> — Core / Other / All customer segment (default service key <code>clingine</code>, env <code>CVA_CORE_SERVICE</code>); compact cloud + segment controls on Matrix and Service Dive; CSV respects segment; faster dashboard payload (single merged-json query); segment flags stored at scan time</li>
        <li><strong>1.0.15</strong> — Nav order: Services → Service Dive → Anomaly → About; About versioning note and changelog catch-up; feature list order aligned with nav</li>
        <li><strong>1.0.14</strong> — Service detail: Open in Service Dive, All/Green/Red customer filter, customer names link to customer pages</li>
        <li><strong>1.0.13</strong> — INSTALL.md, broader .gitignore, Home path overrides with persistence (<code>data/user_config.json</code>)</li>
        <li><strong>1.0.12</strong> — Prior cache-bust and footer alignment with server version</li>
        <li><strong>1.0.11</strong> — Cache busting, About page, version tag</li>
        <li><strong>1.0.10</strong> — Key+value filter visibility fix, removed redundant filter textbox</li>
        <li><strong>1.0.9</strong> — Key+value filter for Service Dive (filter customers by config values)</li>
        <li><strong>1.0.8</strong> — AWS / Azure / Both cloud radio for Matrix + Dive, dive sub-filters, improved dive colors</li>
        <li><strong>1.0.7</strong> — Service Dive page (2nd-level key × customer matrix with modal/outlier)</li>
        <li><strong>1.0.6</strong> — BrokenPipe fix, PID file, Stop server button, click-to-pin tooltips, Anomaly page</li>
        <li><strong>1.0.5</strong> — Vendored highlight.js, safe YAML highlighting</li>
        <li><strong>1.0.4</strong> — Azure customers, Services page, YAML syntax highlighting</li>
        <li><strong>1.0.3</strong> — Port-in-use check, green-only logic, multi-cloud scan, red/green filter</li>
        <li><strong>1.0.2</strong> — Clearer matrix colors (green / red / amber → green / red only)</li>
        <li><strong>1.0.1</strong> — Initial release: scan, matrix, customers, hover tooltips, CSV export</li>
      </ul>
    </div>
  `;

  footerStatus.textContent = `v${info.version}`;
}

// ─────────────────────────────────────────────────────────────── Router ──────

function route() {
  const h = (location.hash || "#/").slice(1);
  const parts = h.split("/").filter(Boolean);
  const [a, ...rest] = parts;

  unfreezeTooltip();

  if (!a || a === "")             return renderHome();
  if (a === "dashboard")          return renderDashboard();
  if (a === "customers")          return renderCustomers();
  if (a === "services")           return renderServices();
  if (a === "anomaly")            return renderAnomaly();
  if (a === "about")              return renderAbout();
  if (a === "dive")               return renderServiceDive(rest[0] ? decodeURIComponent(rest.join("/")) : "");
  if (a === "customer" && rest[0]) return renderCustomer(decodeURIComponent(rest.join("/")));
  if (a === "service"  && rest[0]) return renderService(decodeURIComponent(rest.join("/")));
  renderHome();
}

window.addEventListener("hashchange", route);
route();
