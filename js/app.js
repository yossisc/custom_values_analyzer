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

  const { customer_names: customers = [], service_keys: services = [], matrix = [] } = data;

  app.innerHTML = `
    <div class="legend">
      <span><i class="pill on"></i> <strong>Green</strong> — <code>enabled: true</code></span>
      <span><i class="pill off"></i> <strong>Red</strong> — anything else; hover for YAML &nbsp;·&nbsp; <em>click to pin / unpin</em></span>
    </div>
    <div class="filters">
      <label>Filter services <input type="search" id="f-svc" placeholder="substring…" autocomplete="off" /></label>
      <label>Filter customers <input type="search" id="f-cust" placeholder="substring…" autocomplete="off" /></label>
      ${cloudRadioHTML("mx-cloud")}
      <label id="f-color-wrap" class="hidden">Filter
        <select id="f-color">
          <option value="">all</option>
          <option value="red">red</option>
          <option value="green">green</option>
        </select>
      </label>
      <a class="btn" href="/api/export/matrix.csv" download="matrix.csv">Download CSV</a>
    </div>
    <div class="matrix-wrap" id="matrix-wrap"></div>
  `;

  const wrap       = document.getElementById("matrix-wrap");
  const fCust      = document.getElementById("f-cust");
  const fSvc       = document.getElementById("f-svc");
  const fColor     = document.getElementById("f-color");
  const fColorWrap = document.getElementById("f-color-wrap");

  const byService = Object.fromEntries(matrix.map((r) => [r.service, r.by_customer]));

  function paint() {
    const cloud = getCloud("mx-cloud");
    const svcQ  = fSvc.value;
    const custQ = fCust.value;

    // Cloud filter first, then text filter
    const cloudCustomers = customers.filter((c) => cloud === "both" || cloudOf(c) === cloud);
    const fsBase = filterList(services, svcQ);
    const fcBase = filterList(cloudCustomers, custQ);

    const otherFiltersUsed = svcQ.trim() !== "" || custQ.trim() !== "" || cloud !== "both";
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
      <div class="filters">
        <label>Filter <input type="search" id="f-list" placeholder="name…" autocomplete="off" /></label>
      </div>
      <ul class="customer-list" id="cust-ul"></ul>
    </div>
  `;

  const ul  = document.getElementById("cust-ul");
  const inp = document.getElementById("f-list");

  function paint() {
    const items = filterList(list.map((x) => x.name), inp.value);
    ul.innerHTML = items
      .map((name) => `<li><a href="#/customer/${encodeURIComponent(name)}" data-route>${esc(name)}</a></li>`)
      .join("");
  }
  inp.addEventListener("input", paint);
  paint();
}

// ──────────────────────────────────────────────────────── Services page ──────

async function renderServices() {
  let list = [];
  try { list = await api("/api/services"); }
  catch (e) { app.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`; return; }

  app.innerHTML = `
    <div class="panel" style="max-width:36rem;">
      <h2>Services (${list.length})</h2>
      <div class="filters">
        <label>Filter <input type="search" id="f-svc-list" placeholder="service key…" autocomplete="off" /></label>
      </div>
      <ul class="customer-list" id="svc-ul"></ul>
    </div>
  `;

  const ul  = document.getElementById("svc-ul");
  const inp = document.getElementById("f-svc-list");

  function paint() {
    const items = filterList(list.map((x) => x.name), inp.value);
    ul.innerHTML = items
      .map((name) => `<li><a href="#/service/${encodeURIComponent(name)}" data-route>${esc(name)}</a></li>`)
      .join("");
  }
  inp.addEventListener("input", paint);
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

async function renderServiceDive(preselect = "") {
  let serviceList = [];
  try { serviceList = await api("/api/services"); }
  catch (e) { app.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`; return; }

  const names = serviceList.map((s) => s.name);
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
        <div class="filters dive-subfilters hidden" id="dive-subfilters">
          <label>Filter keys
            <input type="search" id="dive-fkey" placeholder="key name…" autocomplete="off" />
          </label>
          <label>Filter customers
            <input type="search" id="dive-fcust" placeholder="customer…" autocomplete="off" />
          </label>
          ${cloudRadioHTML("dive-cloud")}
          <span class="dive-legend">
            <span class="dive-pill modal">■</span>&nbsp;= same as majority &nbsp;&nbsp;
            <span class="dive-pill outlier">■</span>&nbsp;= different &nbsp;&nbsp;
            <span class="dive-pill missing">—</span>&nbsp;= not set
          </span>
        </div>
        <div class="kv-row hidden" id="dive-kv-row">
          <span class="kv-label">Filter key+value</span>
          <input type="search" id="dive-kvkey" placeholder="key…" autocomplete="off" class="kv-input" />
          <span class="kv-contains">contains</span>
          <input type="search" id="dive-kvval" placeholder="value…" autocomplete="off" class="kv-input kv-val" />
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

  function paintDive() {
    if (!diveData) return;
    const cloud   = getCloud("dive-cloud");
    const keyQ    = document.getElementById("dive-fkey")?.value   || "";
    const custQ   = document.getElementById("dive-fcust")?.value  || "";
    const kvKey   = document.getElementById("dive-kvkey")?.value  || "";
    const kvValue = document.getElementById("dive-kvval")?.value  || "";
    renderDiveTable(diveData, { cloud, keyQ, custQ, kvKey, kvValue }, bodyEl);
  }

  selectEl.addEventListener("change", () => loadDive(selectEl.value));

  async function loadDive(serviceName) {
    if (!serviceName) {
      bodyEl.innerHTML = "";
      subfilters.classList.add("hidden");
      kvRow.classList.add("hidden");
      return;
    }
    bodyEl.innerHTML = '<p style="padding:0.5rem 0;color:var(--muted);">Loading…</p>';
    try {
      diveData = await api(`/api/service-dive?service=${encodeURIComponent(serviceName)}`);
      subfilters.classList.remove("hidden");
      kvRow.classList.remove("hidden");
      if (!subfiltersWired) {
        subfiltersWired = true;
        ["dive-fkey", "dive-fcust", "dive-kvkey", "dive-kvval"].forEach((id) =>
          document.getElementById(id).addEventListener("input", paintDive)
        );
        document.querySelectorAll('input[name="dive-cloud"]').forEach((r) =>
          r.addEventListener("change", paintDive)
        );
      }
      paintDive();
    } catch (e) {
      bodyEl.innerHTML = `<div class="panel"><p class="error-banner">${esc(String(e))}</p></div>`;
    }
  }

  if (preselect && names.includes(preselect)) loadDive(preselect);
}

/**
 * Render the filtered dive table into `container`.
 * Recomputes modal values for the visible customer subset so colors are always
 * meaningful even when cloud / text filters narrow the view.
 */
function renderDiveTable(data, { cloud = "both", keyQ = "", custQ = "", kvKey = "", kvValue = "" }, container) {
  const { service, customers, matrix } = data;

  // Step 1: cloud + customer-text filter
  let fc = customers
    .filter((c) => cloud === "both" || cloudOf(c) === cloud)
    .filter((c) => !custQ.trim() || c.toLowerCase().includes(custQ.toLowerCase()));

  // Step 2: key+value filter (reduces columns, not rows)
  fc = filterCustomersByKV(data, fc, kvKey, kvValue);

  // Step 3: key-name filter (reduces rows only)
  const fs = matrix.filter((row) => !keyQ.trim() || row.key.toLowerCase().includes(keyQ.toLowerCase()));

  if (!fs.length || !fc.length) {
    container.innerHTML = '<div class="panel"><p style="color:var(--muted);">No data for current filters.</p></div>';
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
      ${fs.length} keys &nbsp;·&nbsp; ${fc.length} customers
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
      </p>
      <div class="filters anomaly-filters">
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

    btn.disabled = true;
    results.innerHTML = '<p style="color:var(--muted);">Loading…</p>';

    try {
      const data = await api(
        `/api/anomaly?entity=${entity}&threshold=${encodeURIComponent(threshold)}&color=${color}`
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
