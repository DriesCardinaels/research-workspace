/* Review Helper — guided review coach (client).
 * All gating, checks, and composition are computed by the server
 * (review_core.py); this file renders state and collects input. */
"use strict";

const S = {
  form: null, flow: null, fields: {}, qidx: {}, stepIdx: {},
  paperId: null, state: null, ev: null,
  pos: { step: "s0", page: 0 },
  version: 0, savedVersion: 0, saveTimer: null, inflight: null,
  saveStatus: "", saveError: false,
  showPdf: false, pdfWide: false, pdfFocus: false, annot: null, annotKey: "", pdfAside: null,
  focusMainScroll: 0, focusShowList: false,
  drawer: null, modal: null, menu: false,
  renderSig: "",
};

// ---------------------------------------------------------------- helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $app = () => document.getElementById("app");
const uid = () => Math.random().toString(36).slice(2, 10);
const words = (t) => ((t || "").match(/\S+/g) || []).length;

async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h("textarea", { value: text, style: "position:fixed;opacity:0" });
    document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  toast("Copied");
}
function toast(msg) {
  S.saveStatus = msg; renderStatus();
  setTimeout(() => { if (S.saveStatus === msg) { S.saveStatus = "Saved"; renderStatus(); } }, 1500);
}

function autogrow(ta) {
  const fit = () => { ta.style.height = "auto"; ta.style.height = Math.max(ta.scrollHeight + 2, 0) + "px"; };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
  return ta;
}

// ---------------------------------------------------------------- state access
const A = (qid, dflt) => {
  const a = S.state.answers[qid];
  return a === undefined || a.value === undefined || a.value === null ? dflt : a.value;
};
function setA(qid, value, rerender) {
  S.state.answers[qid] = Object.assign({}, S.state.answers[qid] || {}, { value });
  changed(rerender);
}
const P = (field) => (S.state.pcs[field] || {}).value;
function setP(field, value, rerender) {
  S.state.pcs[field] = Object.assign({}, S.state.pcs[field] || {}, { value });
  changed(rerender);
}
function changed(rerender) {
  S.version++;
  scheduleSave(rerender ? 60 : 350);
  if (rerender) render();
}
const evStep = (sid) => S.ev.steps.find((s) => s.id === sid);
const flowStep = (sid) => S.flow.steps[S.stepIdx[sid]];
const ledger = () => S.state.ledger;
const activeLedger = (type) => ledger().filter((i) => !i.dropped && (!type || i.type === type))
  .sort((a, b) => (a.rank ?? 1e6) - (b.rank ?? 1e6));

// ---------------------------------------------------------------- saving
function scheduleSave(delay = 350) {
  S.saveStatus = "Saving…"; S.saveError = false; renderStatus();
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(doSave, delay);
}
async function doSave(force) {
  clearTimeout(S.saveTimer);
  if (S.inflight) { await S.inflight; if (S.version === S.savedVersion && !force) return; }
  const sentVersion = S.version;
  const snapshot = JSON.parse(JSON.stringify(S.state));
  for (const sm of Object.values(S.state.step_meta || {})) delete sm.complete; // sent once
  S.inflight = (async () => {
    try {
      const res = await api("PUT", `/api/papers/${encodeURIComponent(S.paperId)}`, { state: snapshot, force_backup: !!force });
      S.ev = res.eval;
      S.savedVersion = sentVersion;
      // Never replace S.state: rendered closures hold references into it
      // (ledger items, list entries). Merge only the server-owned bits.
      for (const [sid, sm] of Object.entries(res.state.step_meta || {})) {
        S.state.step_meta[sid] = S.state.step_meta[sid] || {};
        if (sm.completed_at) S.state.step_meta[sid].completed_at = sm.completed_at;
      }
      S.state.meta.updated_at = res.state.meta.updated_at;
      if (A("s1_humans") === "no") {
        for (const f of ["irb", "demographics", "diversity"]) S.state.pcs[f].value = res.state.pcs[f].value;
      }
      const t = new Date();
      S.saveStatus = "Saved " + t.toLocaleTimeString(); S.saveError = false;
    } catch (e) {
      S.saveStatus = "Error: not saved (" + e.message + ")"; S.saveError = true;
    } finally {
      S.inflight = null;
    }
    afterSave();
  })();
  return S.inflight;
}
async function flush() {
  if (S.saveTimer || S.version !== S.savedVersion) { clearTimeout(S.saveTimer); S.saveTimer = null; await doSave(); }
  else if (S.inflight) await S.inflight;
}
function afterSave() {
  if (sig() !== S.renderSig) render(); else renderChrome();
}
function sig() {
  const st = evStep(S.pos.step);
  return JSON.stringify([S.pos, st && st.applies, st && st.pages.map((p) => [p.key, p.locked])]);
}

// ---------------------------------------------------------------- boot & routing
async function boot() {
  const cfg = await api("GET", "/api/config");
  S.form = cfg.form; S.flow = cfg.flow; S.defaultPdf = cfg.default_pdf;
  S.form.fields.forEach((f) => (S.fields[f.id] = f));
  S.flow.steps.forEach((st, i) => { S.stepIdx[st.id] = i; st.questions.forEach((q) => (S.qidx[q.id] = q)); });
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", (e) => { if (S.version !== S.savedVersion) { doSave(); e.preventDefault(); } });
  route();
}
async function route() {
  S.pdfFocus = false;
  $app().classList.remove("pdf-focus");
  const m = location.hash.match(/^#\/p\/(.+)$/);
  if (!m) { S.paperId = null; destroyAnnot(); return renderStart(); }
  try {
    const res = await api("GET", `/api/papers/${m[1]}`);
    if (S.paperId !== decodeURIComponent(m[1])) destroyAnnot();
    S.paperId = decodeURIComponent(m[1]);
    S.state = res.state; S.ev = res.eval; S.version = S.savedVersion = 0;
    S.pos = Object.assign({ step: "s0", page: 0 }, S.state.current || {});
    S.showPdf = !!S.state.meta.pdf_path;
    render();
  } catch (e) {
    location.hash = "";
  }
}

async function renderStart() {
  const list = await api("GET", "/api/papers");
  const err = h("div");
  const pid = h("input", { type: "text", placeholder: "e.g. 1234" });
  const title = h("input", { type: "text", placeholder: "Paper title" });
  const pdf = h("input", { type: "text", placeholder: "/path/to/paper.pdf (optional)", value: S.defaultPdf || "" });
  const create = async (e) => {
    e.preventDefault();
    try {
      const res = await api("POST", "/api/papers", { paper_id: pid.value, title: title.value, pdf_path: pdf.value });
      location.hash = "#/p/" + encodeURIComponent(res.state.meta.paper_id);
    } catch (x) { err.replaceChildren(h("div", { class: "note bad" }, x.message)); }
  };
  $app().replaceChildren(h("div", { class: "start" },
    h("h1", {}, "Review Helper"),
    h("p", { class: "muted" }, `${S.flow.venue}. A guided, step-by-step review coach. Runs fully offline; nothing leaves this machine.`),
    list.length ? h("h2", {}, "Continue a review") : null,
    h("div", { class: "papers" }, list.map((p) => h("button", { class: "paper", onclick: () => (location.hash = "#/p/" + encodeURIComponent(p.paper_id)) },
      h("span", {}, h("strong", {}, p.title || "(untitled)"), h("br"), h("span", { class: "muted small" }, `#${p.paper_id} · ${p.current_step}`)),
      h("span", { class: "muted small" }, `${p.pcs_filled}/${p.pcs_total} PCS fields`, h("br"), (p.updated_at || "").slice(0, 16).replace("T", " "))))),
    h("h2", {}, "Start a new review"),
    h("form", { class: "card", onsubmit: create },
      h("label", { class: "field" }, "Paper ID (PCS submission number)"), pid,
      h("label", { class: "field" }, "Title"), title,
      h("label", { class: "field" }, "PDF path"), pdf,
      err,
      h("div", { class: "inline-actions" }, h("button", { class: "btn primary", type: "submit" }, "Start guided review"))),
  ));
}

// ---------------------------------------------------------------- navigation
function goto(step, page = 0) {
  S.pos = { step, page };
  S.state.current = { step, page };
  const sm = (S.state.step_meta[step] = S.state.step_meta[step] || {});
  if (!sm.visited) sm.visited = true;
  changed(false);
  render();
  document.querySelector(".main")?.scrollTo(0, 0);
}
function nextApplicable(fromIdx, dir) {
  let i = fromIdx + dir;
  while (i >= 0 && i < S.flow.steps.length) {
    const st = evStep(S.flow.steps[i].id);
    if (st.applies || st.id === "s7") return S.flow.steps[i].id;
    i += dir;
  }
  return null;
}
async function next() {
  await flush();
  const st = evStep(S.pos.step);
  if (!st.applies) {
    S.state.step_meta[st.id] = Object.assign(S.state.step_meta[st.id] || {}, { complete: true });
    const n = nextApplicable(S.stepIdx[st.id], 1);
    return n ? goto(n) : null;
  }
  const page = st.pages[S.pos.page];
  if (page && (page.missing.length || page.locked)) {
    const f = document.querySelector(".foot");
    f?.classList.remove("shake"); void f?.offsetWidth; f?.classList.add("shake");
    return;
  }
  if (S.pos.page < st.pages.length - 1) return goto(st.id, S.pos.page + 1);
  S.state.step_meta[st.id] = Object.assign(S.state.step_meta[st.id] || {}, { complete: true });
  const n = nextApplicable(S.stepIdx[st.id], 1);
  if (n) goto(n); else { changed(false); render(); }
}
function back() {
  if (S.pos.page > 0) return goto(S.pos.step, S.pos.page - 1);
  const p = nextApplicable(S.stepIdx[S.pos.step], -1);
  if (p) { const st = evStep(p); goto(p, Math.max(0, st.pages.length - 1)); }
}
function onKey(e) {
  if (!S.paperId) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); doSave(true); }
  else if (S.pdfFocus) {
    if (e.key === "Escape") {
      e.preventDefault();
      // The app's listener runs before the annotator's. Dismiss PDF popovers
      // first; comment editors already stop propagation for their own Escape.
      if (S.annot && (!S.annot.pop.hidden || !S.annot.selMenu.hidden)) {
        S.annot.closePop(); S.annot.hideSelMenu();
      } else setPdfFocus(false);
    } else if ((mod && e.key === "Enter") || (e.altKey && ["ArrowRight", "ArrowLeft"].includes(e.key))) {
      e.preventDefault();
    }
  }
  else if (mod && e.key === "Enter") { e.preventDefault(); next(); }
  else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); const n = nextApplicable(S.stepIdx[S.pos.step], 1); if (n) goto(n); }
  else if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); const p = nextApplicable(S.stepIdx[S.pos.step], -1); if (p) goto(p); }
  else if (e.key === "Escape" && (S.drawer || S.modal || S.menu)) { S.drawer = S.modal = null; S.menu = false; render(); }
}

function setPdfFocus(focus) {
  if (focus === S.pdfFocus) return;
  if (focus && (!S.showPdf || !(S.state.meta.pdf_path || "").trim())) return;
  const main = document.querySelector(".main");
  if (focus) {
    S.focusMainScroll = main?.scrollTop || 0;
    S.focusShowList = S.annot?.showList || false;
  }
  S.pdfFocus = focus;
  // Change the layout in place: keep inputs, annotations, zoom and scroll state.
  $app().classList.toggle("pdf-focus", focus);
  if (S.annot) {
    S.annot.showList = focus ? false : S.focusShowList;
    S.annot.renderList(); S.annot.renderBar();
  }
  if (!focus && main) main.scrollTop = S.focusMainScroll;
  document.getElementById(focus ? "exit-pdf-focus" : "enter-pdf-focus")?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- top-level render
function render() {
  if (!S.paperId) return;
  const st = evStep(S.pos.step);
  if (st.applies && S.pos.page >= st.pages.length) S.pos.page = Math.max(0, st.pages.length - 1);
  S.renderSig = sig();
  const pdfScroll = S.annot ? S.annot.scroller.scrollTop : 0;
  const layout = h("div", { class: "layout" + (S.showPdf ? " with-pdf" + (S.pdfWide ? " pdf-wide" : "") : "") },
    h("nav", { class: "rail", id: "rail" }),
    h("div", { class: "main" }, h("div", { class: "wrap", id: "stepview" }, renderStep())),
    S.showPdf ? pdfPane() : null);
  const scrollY = S.pdfFocus ? S.focusMainScroll : document.querySelector(".main")?.scrollTop || 0;
  const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : null;
  $app().classList.toggle("pdf-focus", S.pdfFocus);
  $app().replaceChildren(...[h("header", { class: "top", id: "top" }),
    h("div", { class: "pdf-focus-controls" }, h("button", {
      class: "btn small", id: "exit-pdf-focus", onclick: () => setPdfFocus(false),
      title: "Restore the review panels (Escape)", "data-focus": "exit-pdf-focus",
    }, "Exit focus")),
    layout, h("div", { class: "foot", id: "foot" }),
    S.drawer ? [h("div", { class: "scrim", onclick: () => { S.drawer = null; render(); } }), renderDrawer()] : null,
    S.modal ? [h("div", { class: "scrim", onclick: () => { S.modal = null; render(); } }), renderModal()] : null].flat().filter(Boolean));
  const main = document.querySelector(".main"); if (main) main.scrollTop = scrollY;
  if (S.annot && S.showPdf) S.annot.scroller.scrollTop = pdfScroll;
  if (active) document.querySelector(`[data-focus="${active}"]`)?.focus();
  renderChrome();
}
// The PDF pane is created once per paper and re-attached on every render, so
// rendered pages, zoom, scroll position and the current tool survive navigation.
function pdfPane() {
  if (!S.pdfAside) S.pdfAside = h("aside", { class: "pdf" });
  if (!(S.state.meta.pdf_path || "").trim()) {
    destroyAnnot();
    S.pdfAside.replaceChildren(h("div", { class: "empty" }, "No PDF path set. Add one in Step 0."));
    return S.pdfAside;
  }
  const key = S.paperId + "|" + S.state.meta.pdf_path;
  if (!S.annot || S.annotKey !== key) {
    destroyAnnot();
    const base = `/api/papers/${encodeURIComponent(S.paperId)}`;
    S.annot = new PdfAnnotator({
      pdfUrl: base + "/pdf", annUrl: base + "/annotations",
      exportUrl: base + "/annotated.pdf", openExportUrl: base + "/annotated.pdf",
      colors: S.flow.annotation,
      onLedger: (prefill) => {
        setPdfFocus(false);
        const fs = flowStep(S.pos.step);
        S.drawer = { prefill: Object.assign({ source_step: S.pos.step, dimension: fs.dimension || "" }, prefill) };
        render();
      },
    });
    S.annotKey = key;
    flush().then(() => S.annot && S.annot.open()); // the server reads the saved PDF path
  }
  if (S.annot.root.parentNode !== S.pdfAside) S.pdfAside.replaceChildren(S.annot.root);
  return S.pdfAside;
}
function destroyAnnot() {
  if (S.annot) S.annot.destroy();
  S.annot = null; S.annotKey = "";
}

function renderChrome() {
  if (!S.paperId || !document.getElementById("top")) return;
  renderTop(); renderRail(); renderFoot(); renderLiveBits();
}
function renderStatus() {
  const el = document.getElementById("savestatus");
  if (el) { el.textContent = S.saveStatus; el.className = "save" + (S.saveError ? " err" : ""); }
}

function renderTop() {
  const ev = S.ev;
  const pct = Math.round((100 * ev.pcs_filled) / ev.pcs_total);
  document.getElementById("top").replaceChildren(
    h("button", { class: "btn ghost brand", onclick: async () => { await flush(); location.hash = ""; }, title: "All reviews" }, "Review Helper"),
    h("span", { class: "paper-title", title: S.state.meta.title }, `#${S.paperId} ${S.state.meta.title || ""}`),
    h("span", { class: "spacer" }),
    h("span", { class: "meter", title: "PCS fields built so far" }, "PCS", h("span", { class: "bar" }, h("i", { style: `width:${pct}%` })), `${ev.pcs_filled}/${ev.pcs_total}`),
    h("span", { id: "savestatus", class: "save" + (S.saveError ? " err" : "") }, S.saveStatus || "Saved"),
    h("button", { class: "btn small", onclick: () => doSave(true), title: "Save now (Ctrl/Cmd+S)" }, "Save"),
    h("button", { class: "btn small", onclick: () => { S.drawer = { prefill: null }; render(); } }, `Ledger (${activeLedger().length})`),
    h("button", { class: "btn small", onclick: () => { S.showPdf = !S.showPdf; render(); } }, S.showPdf ? "Hide PDF" : "PDF"),
    S.showPdf ? h("button", { class: "btn small", onclick: () => { S.pdfWide = !S.pdfWide; render(); }, title: "Give the PDF more room for annotating" }, S.pdfWide ? "Narrow PDF" : "Wide PDF") : null,
    S.showPdf && (S.state.meta.pdf_path || "").trim() ? h("button", {
      class: "btn small", id: "enter-pdf-focus", onclick: () => setPdfFocus(true),
      title: "Collapse the review panels and focus on the PDF", "data-focus": "enter-pdf-focus",
    }, "Focus PDF") : null,
    h("button", { class: "btn small", onclick: () => { S.modal = "about"; render(); } }, "About reviewing"),
    h("span", { class: "menu" },
      h("button", { class: "btn small", onclick: () => { S.menu = !S.menu; renderTop(); } }, "Export ▾"),
      S.menu ? h("div", { class: "menu-list" },
        h("button", { onclick: async () => { await flush(); S.menu = false; location.href = `/api/papers/${encodeURIComponent(S.paperId)}/review.md`; } }, "Download review.md"),
        h("button", { onclick: async () => { await flush(); S.menu = false; const r = await fetch(`/api/papers/${encodeURIComponent(S.paperId)}/pcs.txt`); copyText(await r.text()); renderTop(); } }, "Copy PCS sheet (all fields)")) : null),
  );
}

function renderRail() {
  const rail = document.getElementById("rail");
  if (!rail) return;
  const icons = { done: "✓", needs_recheck: "!", skipped: "–", in_progress: "", not_started: "" };
  const labels = { done: "done", needs_recheck: "needs re-check", skipped: "not applicable", in_progress: "in progress", not_started: "not started" };
  rail.replaceChildren(h("ol", {}, S.ev.steps.map((st, i) => h("li", { class: st.id === S.pos.step ? "current" : "" },
    h("button", { onclick: () => goto(st.id, 0) },
      h("span", { class: "st " + st.status, title: labels[st.status] }, icons[st.status]),
      h("span", {},
        h("div", { class: "name" }, `${i}. ${st.title}`),
        h("div", { class: "sub" }, labels[st.status] + (st.stale_because ? " (changed: " + st.stale_because.map((d) => flowStep(d).title).join(", ") + ")" : "")),
        st.feeds.length ? h("div", { class: "chips" }, st.feeds.map((f) => h("span", { class: "chip" + (P(f) ? " filled" : ""), title: S.fields[f].heading }, S.fields[f].heading))) : null))))),
    h("div", { class: "rail-foot" }, h("kbd", {}, "⌘/Ctrl+Enter"), " next · ", h("kbd", {}, "Alt+←/→"), " steps · ", h("kbd", {}, "⌘/Ctrl+S"), " save"));
}

function renderFoot() {
  const foot = document.getElementById("foot");
  if (!foot) return;
  const st = evStep(S.pos.step);
  const page = st.applies ? st.pages[S.pos.page] : null;
  const reasons = page ? (page.locked ? [page.lock_reason] : page.missing) : [];
  const lastPage = !st.applies || S.pos.page >= st.pages.length - 1;
  const isEnd = lastPage && !nextApplicable(S.stepIdx[st.id], 1);
  const atStart = S.pos.page === 0 && S.stepIdx[st.id] === 0;
  foot.replaceChildren(...[
    h("button", { class: "btn", onclick: back, disabled: atStart }, "← Back"),
    h("span", { class: "why" }, reasons.length ? "To continue: " + reasons.join(" · ") : ""),
    isEnd ? null : h("button", { class: "btn primary" + (reasons.length ? " dim" : ""), onclick: next, title: reasons.join(" · ") || null }, lastPage ? "Finish step →" : "Next →")].filter(Boolean));
}

function renderLiveBits() {
  // parts of the step view that depend on the server evaluation
  const box = document.getElementById("stepwarnings");
  if (box) box.replaceChildren(...stepWarnings());
  document.querySelectorAll("[data-live]").forEach((el) => { const fn = LIVE[el.dataset.live]; if (fn) el.replaceChildren(...[fn()].flat().filter(Boolean)); });
  const dots = document.getElementById("dots"); if (dots) dots.replaceChildren(...pageDots());
}
const LIVE = {};

function stepWarnings() {
  const sid = S.pos.step;
  if (sid === "s12") return [];
  const list = S.ev.checks.filter((c) => c.step === sid && !c.id.startsWith("unset:"));
  if (!list.length) return [];
  return [h("h3", {}, "Heads-up for this step"), ...list.map((c) => h("div", { class: "note " + (c.severity === "info" ? "info" : "warn") }, c.message))];
}
function pageDots() {
  const st = evStep(S.pos.step);
  return st.pages.map((p, i) => h("button", {
    class: [p.missing.length ? "" : "ok", i === S.pos.page ? "cur" : "", p.locked ? "locked" : ""].join(" "),
    title: p.key, onclick: () => goto(st.id, i),
  }));
}

// ---------------------------------------------------------------- step view
function renderStep() {
  const fs = flowStep(S.pos.step);
  const st = evStep(S.pos.step);
  const i = S.stepIdx[fs.id];
  const head = h("div", { class: "step-head" },
    h("div", { class: "kicker" }, `Step ${i} of ${S.flow.steps.length - 1}`),
    h("h1", {}, fs.title),
    h("p", {}, fs.intro),
    fs.feeds.length ? h("div", { class: "feeds" }, "Builds PCS:", fs.feeds.map((f) => h("span", { class: "chip" + (P(f) ? " filled" : "") }, S.fields[f].heading))) : null,
    st.status === "needs_recheck" ? h("div", { class: "note warn" }, "You changed earlier steps since finishing this one (" + st.stale_because.map((d) => flowStep(d).title).join(", ") + "). Re-check your answers here, then finish the step again.") : null,
    fs.principles.length ? h("details", { class: "principles" }, h("summary", {}, "Keep in mind"), fs.principles.map((p) => h("p", {}, h("strong", {}, S.flow.principles[p].title + ". "), S.flow.principles[p].text))) : null);

  if (!st.applies) {
    return [head, h("div", { class: "card" }, h("h2", {}, "Not applicable"),
      h("p", {}, "In Step 1 you said the paper has no human participants, so IRB Approval Check, Participant Demographics and Participant Diversity are set to “Not applicable (No experiment with human participants)”."),
      h("button", { class: "btn", onclick: () => goto("s1", S.flow.steps[1].questions.findIndex((q) => q.id === "s1_humans")) }, "Change that answer"))];
  }
  const page = st.pages[S.pos.page];
  const qs = page.qids.map((id) => S.qidx[id]);
  const body = page.locked
    ? [h("div", { class: "card" }, h("h2", {}, qs[0].text), h("div", { class: "note lock" }, "🔒 ", page.lock_reason,
        h("div", { class: "inline-actions", style: "justify-content:center" }, h("button", { class: "btn", onclick: () => goto(st.id, st.pages.findIndex((p) => p.missing.length)) }, "Go to the first unanswered question"))))]
    : qs.map((q) => renderQuestion(q, page, fs));
  return [head,
    st.pages.length > 1 ? h("div", { class: "progress" }, `Question ${S.pos.page + 1} of ${st.pages.length}`, h("div", { class: "dots", id: "dots" }, pageDots())) : null,
    body,
    h("div", { class: "warnings", id: "stepwarnings" }, stepWarnings())];
}

function pcsBox(field) {
  const f = S.fields[field];
  return h("div", { class: "pcs-box" }, h("div", { class: "lbl" }, "PCS · " + f.heading), f.helper.map((t) => h("p", {}, t)));
}
function addToLedgerBtn(prefill, label = "+ Add to ledger") {
  return h("button", { class: "btn small", onclick: () => { S.drawer = { prefill }; render(); } }, label);
}
function cardFor(q, ...kids) {
  return h("div", { class: "card" }, h("h2", {}, q.text), q.help ? h("p", { class: "help" }, q.help) : null, kids);
}
function textArea(value, oninput, opts = {}) {
  const ta = h("textarea", Object.assign({ value: value || "", class: opts.tall ? "tall" : "", placeholder: opts.placeholder || "", "data-focus": opts.focus || null }, {}));
  const wc = h("div", { class: "wc" }, `${words(value)} words`);
  ta.addEventListener("input", () => { oninput(ta.value); wc.textContent = `${words(ta.value)} words`; });
  autogrow(ta);
  return [ta, opts.noCount ? null : wc];
}
function options(list, current, onpick, opts = {}) {
  return h("div", { class: "opts" + (opts.row ? " row" : "") }, list.map((o) => {
    const val = typeof o === "string" ? o : o.value;
    const sel = opts.multi ? (current || []).includes(val) : current === val;
    return h("button", {
      type: "button", class: ["opt", sel ? "sel" : "", opts.multi ? "multi" : "", opts.suggested === val ? "suggested" : ""].join(" "),
      onclick: () => onpick(val),
    }, h("span", { class: "mark" }), h("span", {}, h("span", { class: "ot" }, (opts.labels && opts.labels[val]) || val), opts.desc && opts.desc[val] ? h("span", { class: "od" }, opts.desc[val]) : null));
  }));
}
const CHECK_LABELS = { yes: "Yes", partial: "Partially", no: "No", na: "N/A", unsure: "Unsure" };

function recap(fs) {
  const items = [];
  for (const q of fs.questions) {
    const v = A(q.id);
    if (q.type === "check" && v && v.status) items.push(h("li", {}, h("span", { class: "tag " + v.status }, CHECK_LABELS[v.status]), " — ", q.text, v.note ? h("span", { class: "muted" }, " · " + v.note) : null));
    if (q.type === "claim_review") {
      const cl = claimList();
      cl.forEach((c) => { const r = (v || {})[c.id]; if (r && r.support) items.push(h("li", {}, h("span", { class: "tag " + r.support }, r.support === "Not" ? "Not supported" : r.support), " — ", c.text, r.missing ? h("span", { class: "muted" }, " · " + r.missing) : null)); });
    }
    if ((q.type === "choice" || q.type === "text") && v && q.id.startsWith(fs.id + "_") && fs.id !== "s1") items.push(h("li", {}, q.text, " ", h("strong", {}, String(v))));
  }
  const led = activeLedger().filter((i) => i.source_step === fs.id);
  if (!items.length && !led.length) return null;
  return h("div", { class: "recap" }, h("h3", {}, "Your evidence so far"), h("ul", {}, items,
    led.map((i) => h("li", {}, h("span", { class: "badge " + i.type }, i.type), " ", i.text || i.what))));
}
const claimList = () => (A("s1_claims", []) || []).filter((c) => (c.text || "").trim());

// ---------------------------------------------------------------- question renderers
function renderQuestion(q, page, fs) {
  const R = RENDER[q.type];
  return R ? R(q, page, fs) : cardFor(q, h("p", { class: "muted" }, "Unsupported question type " + q.type));
}
const RENDER = {
  meta(q) {
    const m = S.state.meta;
    const bind = (k) => (e) => { m[k] = e.target.value; changed(false); };
    return cardFor(q,
      h("label", { class: "field" }, "Paper ID"), h("input", { type: "text", value: m.paper_id, disabled: true }),
      h("label", { class: "field" }, "Title"), h("input", { type: "text", value: m.title || "", oninput: bind("title"), "data-focus": "meta-title" }),
      h("label", { class: "field" }, "Your role"),
      options(["Primary (coordinator)", "Secondary", "External reviewer"], m.role, (v) => { m.role = v; changed(true); }, { row: true }),
      h("label", { class: "field" }, "PDF path (optional, shown side by side, served locally only)"),
      h("input", { type: "text", value: m.pdf_path || "", placeholder: "/path/to/paper.pdf", oninput: bind("pdf_path"), "data-focus": "meta-pdf" }));
  },
  ack(q) {
    const v = A(q.id) === true;
    return cardFor(q, options([{ value: "yes" }], v ? "yes" : null, () => setA(q.id, !v, true), { multi: true, labels: { yes: "I agree" } }));
  },
  text(q) {
    return cardFor(q, textArea(A(q.id, ""), (t) => setA(q.id, t), { focus: q.id }));
  },
  justification(q, page, fs) {
    const field = (q.feeds || []).find((f) => f !== "review");
    return cardFor(q, field && P(field) ? h("p", { class: "muted small" }, `You rated ${S.fields[field].heading}: `, h("strong", {}, P(field))) : null,
      recap(fs),
      h("p", { class: "help" }, "This text goes into your review. Be specific: point to sections, figures, or results."),
      textArea(A(q.id, ""), (t) => setA(q.id, t), { focus: q.id }));
  },
  choice(q) {
    const v = A(q.id);
    const offer = q.ledger_offer && v === q.ledger_offer.on
      ? h("div", { class: "note warn" }, "IEEE VR strongly encourages treating this as a primary concern. ",
          addToLedgerBtn({ type: q.ledger_offer.type, text: q.ledger_offer.text, source_step: stepOf(q), source_q: q.id, dimension: flowStep(stepOf(q)).dimension }, "Add as major concern"))
      : null;
    const must = q.must_equal && v && v !== q.must_equal ? h("div", { class: "note warn" }, "Go back and revise until the answer is “" + q.must_equal + "”.") : null;
    return cardFor(q, options(q.options, v, (o) => {
      setA(q.id, o, false);
      if (q.id === "s1_humans" && o === "no") for (const f of ["irb", "demographics", "diversity"]) S.state.pcs[f].value = S.fields[f].na_option;
      render();
    }, { labels: q.option_labels, row: q.options.length <= 4 && !q.option_labels }), offer, must);
  },
  multi(q) {
    const v = A(q.id, []);
    return cardFor(q, options(q.options, v, (o) => {
      let next = v.includes(o) ? v.filter((x) => x !== o) : [...v, o];
      if (o === "Nothing reported" && next.includes(o)) next = [o];
      else if (o !== "Nothing reported") next = next.filter((x) => x !== "Nothing reported");
      setA(q.id, next, true);
    }, { multi: true, desc: q.option_help }));
  },
  check(q, page, fs) {
    const v = A(q.id, {}) || {};
    const opts = q.options || ["yes", "partial", "no", "na", "unsure"];
    const set = (patch, rr) => setA(q.id, Object.assign({}, v, patch), rr);
    const bad = v.status === "no" || v.status === "partial";
    return cardFor(q,
      options(opts, v.status, (o) => set({ status: o }, true), { row: true, labels: CHECK_LABELS }),
      h("label", { class: "field" }, (v.status === "na" || v.status === "unsure") ? "Reason (required)" : "Note: where in the paper, what exactly (optional)"),
      textArea(v.note || "", (t) => { v.note = t; set({ note: t }); }, { noCount: true, focus: q.id + "-note" }),
      bad && fs.id === "s0" ? h("div", { class: "note warn" }, "This may be grounds for desk rejection. Consider contacting the coordinator or Paper Chairs before investing in a full review.") : null,
      bad && fs.id !== "s0" ? h("div", { class: "inline-actions" },
        addToLedgerBtn({ type: "major", text: q.text.replace(/\?$/, "") + ": " + (v.note || ""), location: "", source_step: fs.id, source_q: q.id, dimension: fs.dimension }, "+ Add as concern to ledger")) : null);
  },
  claims(q) {
    const list = A(q.id, []) || [];
    const save = (rr) => setA(q.id, list.map((c) => Object.assign({}, c)), rr);
    return cardFor(q,
      list.map((c, i) => h("div", { class: "list-item" },
        h("div", { class: "row" }, h("strong", {}, `Claim ${i + 1}`), h("button", { class: "btn small danger", onclick: () => { list.splice(i, 1); save(true); } }, "Remove")),
        h("label", { class: "field" }, "Claim"), textArea(c.text, (t) => { c.text = t; save(); }, { noCount: true, focus: "claim-t-" + c.id }),
        h("div", { class: "grid2" },
          h("div", {}, h("label", { class: "field" }, "Where it's stated"), h("input", { type: "text", value: c.location || "", placeholder: "e.g. Sec. 1, p. 2", oninput: (e) => { c.location = e.target.value; save(); }, "data-focus": "claim-l-" + c.id })),
          h("div", {}, h("label", { class: "field" }, "Evidence offered"), h("input", { type: "text", value: c.evidence || "", placeholder: "e.g. user study, Fig. 5", oninput: (e) => { c.evidence = e.target.value; save(); }, "data-focus": "claim-e-" + c.id }))))),
      h("button", { class: "btn", onclick: () => { list.push({ id: uid(), text: "", location: "", evidence: "" }); save(true); } }, "+ Add claim"));
  },
  claim_review(q, page, fs) {
    const c = claimList().find((x) => x.id === page.claim_id);
    if (!c) return cardFor(q, h("div", { class: "note warn" }, "No claims yet. ", h("button", { class: "btn small", onclick: () => goto("s1", S.flow.steps[1].questions.findIndex((x) => x.id === "s1_claims")) }, "Add claims in Step 1")));
    const all = Object.assign({}, A(q.id, {}) || {});
    const r = Object.assign({}, all[c.id] || {});
    const set = (patch, rr) => { all[c.id] = Object.assign(r, patch); setA(q.id, all, rr); };
    const idx = claimList().indexOf(c) + 1;
    return h("div", { class: "card" },
      h("h2", {}, `Claim ${idx}: is it supported by the evidence?`),
      h("blockquote", { class: "recap" }, h("strong", {}, c.text), c.location ? h("div", { class: "muted small" }, "Stated in: " + c.location) : null, c.evidence ? h("div", { class: "muted small" }, "Evidence offered: " + c.evidence) : null),
      options(["Fully", "Partially", "Not"], r.support, (o) => set({ support: o }, true), { row: true, labels: { Not: "Not supported" } }),
      h("label", { class: "field" }, r.support && r.support !== "Fully" ? "What's missing? (required)" : "Notes (optional)"),
      textArea(r.missing || "", (t) => set({ missing: t }), { noCount: true, focus: "cr-" + c.id }),
      r.support && r.support !== "Fully" ? h("div", { class: "inline-actions" }, addToLedgerBtn({ type: "major", text: `Claim “${c.text}” is ${r.support === "Not" ? "not" : "only partially"} supported: ${r.missing || ""}`, location: c.location, source_step: fs.id, source_q: q.id, dimension: "soundness" }, "+ Add as concern to ledger")) : null);
  },
  pcs_choice(q, page, fs) {
    const f = S.fields[q.field];
    const rub = q.rubric ? S.flow.rubrics[q.rubric] : null;
    const suggested = q.suggest ? S.ev.suggestions[q.suggest] : null;
    return h("div", { class: "card" },
      h("h2", {}, q.text), pcsBox(q.field), recap(fs),
      q.principles ? q.principles.map((p) => h("div", { class: "note info" }, h("strong", {}, S.flow.principles[p].title + ". "), S.flow.principles[p].text)) : null,
      suggested ? h("p", { class: "muted small" }, "Based on what you ticked, the tool suggests: ", h("strong", {}, suggested), ". You decide.") : null,
      options(f.options, P(q.field), (o) => setP(q.field, o, true), { desc: rub, suggested }),
      q.help ? h("p", { class: "help", style: "margin-top:.6rem" }, q.help) : null);
  },
  pcs_text(q) {
    const field = q.field;
    const ta = h("textarea", { class: "tall", value: P(field) || "", "data-focus": "pcs-" + field });
    const wc = h("div", { class: "wc" });
    const updWc = () => { wc.textContent = `${words(ta.value)} words`; };
    ta.addEventListener("input", () => { setP(field, ta.value); updWc(); });
    autogrow(ta); updWc();
    const assemble = async (confirmFirst) => {
      if (confirmFirst && (P(field) || "").trim() && !confirm("Replace the current text with a fresh draft assembled from your notes? Your edits here will be lost.")) return;
      await flush();
      const res = await api("POST", `/api/papers/${encodeURIComponent(S.paperId)}/compose`, { kind: q.compose, state: S.state });
      setP(field, res.text, true);
    };
    if (!(P(field) || "").trim() && !(S.state.step_meta[stepOf(q)] || {})["assembled_" + field]) {
      S.state.step_meta[stepOf(q)] = Object.assign(S.state.step_meta[stepOf(q)] || {}, { ["assembled_" + field]: true });
      setTimeout(() => assemble(false), 0);
    }
    return h("div", { class: "card" },
      h("h2", {}, q.text), pcsBox(field),
      h("p", { class: "help" }, field === "review"
        ? "Assembled from your section drafts. Read it as the authors will, and polish it here. Changes here are what goes into PCS."
        : "Assembled only from your own answers and ledger. Edit it into a short, neutral summary followed by strengths and weaknesses."),
      ta, wc,
      field === "review" ? h("div", { "data-live": "wordbar" }, LIVE.wordbar()) : null,
      h("div", { class: "inline-actions" }, h("button", { class: "btn small", onclick: () => assemble(true) }, field === "review" ? "Re-assemble from sections" : "Re-assemble from my notes")));
  },
  review_section(q) {
    const sec = S.flow.review_sections.find((s) => s.key === q.section);
    const val = A(q.id, "");
    const refill = async (confirmFirst) => {
      if (confirmFirst && (A(q.id, "") || "").trim() && !confirm("Replace this section with a fresh draft from your notes?")) return;
      await flush();
      const res = await api("POST", `/api/papers/${encodeURIComponent(S.paperId)}/compose`, { kind: "section:" + q.section, state: S.state });
      setA(q.id, res.text, true);
    };
    const sm = (S.state.step_meta.s11 = S.state.step_meta.s11 || {});
    sm.prefilled = sm.prefilled || [];
    if (!val.trim() && !sm.prefilled.includes(q.section)) { sm.prefilled.push(q.section); setTimeout(() => refill(false), 0); }
    return h("div", { class: "card" },
      h("div", { class: "muted small" }, "Review section"), h("h2", {}, sec.label),
      h("p", { class: "help" }, sec.prompt),
      textArea(val, (t) => setA(q.id, t), { tall: true, focus: q.id }),
      h("div", { class: "inline-actions" }, h("button", { class: "btn small", onclick: () => refill(true) }, "Refill from my notes"),
        q.section === "majors" || q.section === "strengths" ? h("button", { class: "btn small", onclick: () => goto("s8", 0) }, "Edit in the ledger (Step 8)") : null),
      !q.required && q.required !== undefined ? h("p", { class: "muted small" }, "Optional: leave empty if there is nothing to say.") : null);
  },
  references(q, page, fs) {
    const list = A(q.id, []) || [];
    const save = (rr) => setA(q.id, list.map((r) => Object.assign({}, r)), rr);
    return cardFor(q,
      list.length ? null : h("p", { class: "muted" }, "None listed. That's fine if prior work is adequately cited."),
      list.map((r, i) => h("div", { class: "list-item" },
        h("label", { class: "field" }, "Citation"), h("input", { type: "text", value: r.citation || "", oninput: (e) => { r.citation = e.target.value; save(); }, "data-focus": "ref-c-" + r.id }),
        h("div", { class: "grid2" },
          h("div", {}, h("label", { class: "field" }, "Year / venue"), h("input", { type: "text", value: r.year || "", oninput: (e) => { r.year = e.target.value; save(); }, "data-focus": "ref-y-" + r.id })),
          h("div", {}, h("label", { class: "field" }, "Why it matters"), h("input", { type: "text", value: r.why || "", oninput: (e) => { r.why = e.target.value; save(); }, "data-focus": "ref-w-" + r.id }))),
        h("div", { class: "inline-actions" },
          options([{ value: "v" }], r.verified ? "v" : null, () => { r.verified = !r.verified; save(true); }, { multi: true, labels: { v: "I verified it exists and says what I claim" } }),
          h("button", { class: "btn small danger", onclick: () => { list.splice(i, 1); save(true); } }, "Remove")))),
      h("button", { class: "btn", onclick: () => { list.push({ id: uid(), citation: "", year: "", why: "", verified: false }); save(true); } }, "+ Add missing reference"));
  },
  ledger_list(q, page, fs) {
    const items = ledger().filter((i) => i.source_q === q.id && !i.dropped);
    const input = h("input", { type: "text", placeholder: "e.g. Typo in Fig. 3 caption", "data-focus": "ll-" + q.id });
    const add = () => { if (!input.value.trim()) return; ledger().push(newItem({ type: q.ledger_type, text: input.value.trim(), source_step: fs.id, source_q: q.id, dimension: fs.dimension })); changed(true); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    return cardFor(q,
      items.map((i) => h("div", { class: "list-item" }, h("div", { class: "row" }, h("span", {}, i.text), h("button", { class: "btn small danger", onclick: () => { i.dropped = true; changed(true); } }, "Remove")))),
      h("div", { class: "row", style: "display:flex;gap:.5rem" }, input, h("button", { class: "btn", onclick: add }, "Add")));
  },
  ledger_strengths(q) {
    const items = activeLedger("strength");
    const concerns = activeLedger("major").length + activeLedger("minor").length;
    const kept = items.filter((i) => i.keep).length;
    const move = (i, d) => { const arr = items; const j = arr.indexOf(i) + d; if (j < 0 || j >= arr.length) return; [arr[j], arr[j - d]] = [arr[j - d], arr[j]]; arr.forEach((x, k) => (x.rank = k)); changed(true); };
    const input = h("input", { type: "text", placeholder: "A genuine strength of the paper…", "data-focus": "new-strength" });
    const add = () => { if (!input.value.trim()) return; ledger().push(newItem({ type: "strength", text: input.value.trim(), keep: true, source_step: "s8", rank: items.length })); changed(true); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    return cardFor(q,
      h("div", { class: "note " + (kept >= Math.min(3, concerns) && kept > 0 ? "ok" : "info") },
        `You're keeping ${kept} strength(s) and have ${concerns} concern(s). Have you named the genuine strengths you'd want a reviewer to see in your own paper?`),
      items.map((i, k) => h("div", { class: "list-item" + (i.keep ? "" : " dropped-soft") },
        h("div", { class: "row" },
          h("span", { class: "badge" }, "#" + (k + 1)),
          h("input", { type: "text", value: i.text || "", oninput: (e) => { i.text = e.target.value; changed(false); }, "data-focus": "st-" + i.id }),
          h("button", { class: "btn small", onclick: () => move(i, -1), title: "Move up" }, "↑"),
          h("button", { class: "btn small", onclick: () => move(i, 1), title: "Move down" }, "↓"),
          h("button", { class: "btn small" + (i.keep ? " primary" : ""), onclick: () => { i.keep = !i.keep; changed(true); } }, i.keep ? "Kept" : "Keep")))),
      h("div", { style: "display:flex;gap:.5rem;margin-top:.5rem" }, input, h("button", { class: "btn", onclick: add }, "Add strength")));
  },
  ledger_triage(q) {
    const items = activeLedger().filter((i) => i.type !== "strength");
    const dropped = ledger().filter((i) => i.dropped);
    S.mergeSel = S.mergeSel || new Set();
    const merge = () => {
      const sel = items.filter((i) => S.mergeSel.has(i.id));
      if (sel.length < 2) return;
      const [first, ...rest] = sel;
      first.text = [first.text, ...rest.map((r) => r.text)].filter(Boolean).join(" / ");
      for (const k of ["what", "where", "why", "fix"]) first[k] = [first[k], ...rest.map((r) => r[k])].filter(Boolean).join(" / ");
      rest.forEach((r) => (r.dropped = true));
      S.mergeSel.clear(); changed(true);
    };
    return cardFor(q,
      items.length ? null : h("p", { class: "muted" }, "No concerns or questions yet. Add them from earlier steps or the ledger."),
      items.map((i) => h("div", { class: "list-item" },
        h("div", { class: "row" },
          h("input", { type: "checkbox", checked: S.mergeSel.has(i.id), onchange: (e) => { e.target.checked ? S.mergeSel.add(i.id) : S.mergeSel.delete(i.id); }, title: "Select to merge", style: "flex:none;width:auto" }),
          h("select", { onchange: (e) => { i.type = e.target.value; changed(true); }, style: "flex:none;width:auto" },
            ["major", "minor", "question", "strength"].map((t) => h("option", { value: t, selected: i.type === t ? "selected" : null }, t))),
          h("span", {}, i.text || i.what, i.dimension ? h("span", { class: "muted small" }, " · " + i.dimension) : null),
          h("button", { class: "btn small danger", onclick: () => { i.dropped = true; changed(true); } }, "Drop")),
        novelty(i) ? h("div", { class: "note warn" }, S.flow.principles.novelty.text) : null)),
      h("div", { class: "inline-actions" }, h("button", { class: "btn small", onclick: merge }, "Merge selected")),
      dropped.length ? h("details", {}, h("summary", { class: "muted small" }, `${dropped.length} dropped`),
        dropped.map((i) => h("div", { class: "row small", style: "display:flex;gap:.5rem;align-items:center" }, h("span", { class: "dropped", style: "flex:1" }, i.text || i.what), h("button", { class: "btn small", onclick: () => { i.dropped = false; changed(true); } }, "Restore")))) : null);
  },
  ledger_majors(q) {
    const items = activeLedger("major");
    const add = () => { ledger().push(newItem({ type: "major", text: "", source_step: "s8" })); changed(true); };
    return cardFor(q,
      h("p", { class: "help" }, "For each major concern: what the issue is, where it is, why it matters to the claims, what would resolve it, and whether that's feasible in the ~1-month revision window."),
      items.length ? null : h("div", { class: "note ok" }, "No major concerns. If that's right, continue."),
      items.map((i, n) => {
        const missing = majorMissing(i);
        const fld = (k, label, ph, big) => [h("label", { class: "field" }, label),
          big ? textArea(i[k] || "", (t) => { i[k] = t; changed(false); }, { noCount: true, focus: `mj-${k}-${i.id}` })
              : h("input", { type: "text", value: i[k] || "", placeholder: ph || "", oninput: (e) => { i[k] = e.target.value; changed(false); }, "data-focus": `mj-${k}-${i.id}` })];
        return h("div", { class: "list-item" },
          h("div", { class: "row" }, h("strong", {}, `Major concern ${n + 1}`),
            h("span", { class: "badge " + (missing.length ? "warn" : "ok"), "data-live": "ready-" + i.id }, missing.length ? "incomplete" : "ready"),
            h("button", { class: "btn small", onclick: () => { i.type = "minor"; changed(true); } }, "Demote to minor"),
            h("button", { class: "btn small danger", onclick: () => { i.dropped = true; changed(true); } }, "Drop")),
          i.text ? h("p", { class: "muted small" }, "Original note: " + i.text) : null,
          fld("what", "What is the issue?", "", true), fld("where", "Where (section/page/figure)?", "e.g. Sec. 4.2, Table 2"),
          fld("why", "Why does it matter to the claims?", "", true), fld("fix", "What would resolve it?", "", true),
          h("label", { class: "field" }, "Feasible within the ~1-month revision?"),
          options(["Yes", "Partly", "No"], i.feasible, (o) => { i.feasible = o; changed(true); }, { row: true }),
          novelty(i) ? h("div", { class: "note warn" }, S.flow.principles.novelty.text, " ", S.flow.principles.overlap.text,
            options([{ value: "c" }], i.novelty_confirmed ? "c" : null, () => { i.novelty_confirmed = !i.novelty_confirmed; changed(true); }, { multi: true, labels: { c: "I've considered this and the concern still holds" } })) : null);
      }),
      h("button", { class: "btn", onclick: add }, "+ Add major concern"));
  },
  dashboard() {
    const dims = ["expertise", "soundness", "reproducibility", "clarity", "references", "irb", "demographics", "diversity"];
    const cnt = (t) => activeLedger(t).length;
    return h("div", { class: "card" }, h("h2", {}, "Where your review stands"),
      h("div", { class: "dash" }, dims.map((d) => h("div", {}, h("div", { class: "k" }, S.fields[d].heading), h("div", { class: "v" }, P(d) ? shortOpt(P(d)) : "—"))),
        h("div", {}, h("div", { class: "k" }, "Strengths kept"), h("div", { class: "v" }, activeLedger("strength").filter((i) => i.keep).length)),
        h("div", {}, h("div", { class: "k" }, "Major concerns"), h("div", { class: "v" }, cnt("major"))),
        h("div", {}, h("div", { class: "k" }, "Minor concerns"), h("div", { class: "v" }, cnt("minor")))),
      h("div", { class: "recap" }, h("h3", {}, "How IEEE VR decides"), h("ul", {}, S.flow.outcomes.map((o) => h("li", {}, o)))),
      activeLedger("major").length ? h("div", { class: "recap" }, h("h3", {}, "Major concerns"), h("ol", {}, activeLedger("major").map((i) => h("li", {}, i.what || i.text, i.feasible ? h("span", { class: "muted" }, ` (feasible: ${i.feasible})`) : null)))) : null);
  },
  checks() {
    const res = S.state.check_resolutions;
    const list = S.ev.checks;
    const set = (id, v) => { if (v) res[id] = v; else delete res[id]; changed(true); };
    const open = list.filter((c) => !res[c.id]).length;
    return h("div", { class: "card checks" }, h("h2", {}, "Consistency checks"),
      h("p", { class: "help" }, "Fix what you can (use “Go to step”), then tick each item as handled or dismiss it deliberately. The PCS sheet unlocks when every item is resolved."),
      list.length ? null : h("div", { class: "note ok" }, "No issues found."),
      open === 0 && list.length ? h("div", { class: "note ok" }, "All checks resolved.") : null,
      list.map((c) => h("div", { class: "chk" + (res[c.id] ? " resolved" : "") },
        h("span", { class: "badge " + (c.severity === "info" ? "" : "warn") }, flowStep(c.step) ? `Step ${S.stepIdx[c.step]}` : ""),
        h("span", { class: "msg" }, c.message, res[c.id] ? h("span", { class: "muted small" }, ` (${res[c.id]})`) : null),
        res[c.id] ? h("button", { class: "btn small", onclick: () => set(c.id, null) }, "Undo")
          : [h("button", { class: "btn small", onclick: () => goto(c.step, 0) }, "Go to step"),
             h("button", { class: "btn small", onclick: () => set(c.id, "handled") }, "✓ Handled"),
             h("button", { class: "btn small", onclick: () => set(c.id, "dismissed") }, "Dismiss")])));
  },
  sheet() {
    const copyAll = async () => { await flush(); const r = await fetch(`/api/papers/${encodeURIComponent(S.paperId)}/pcs.txt`); copyText(await r.text()); };
    return h("div", { class: "card" }, h("h2", {}, "PCS sheet"),
      h("p", { class: "help" }, "Exactly the PCS form, in order. Copy each field into PCS. Edits here sync back to the step they came from."),
      h("div", { class: "inline-actions" }, h("button", { class: "btn primary", onclick: copyAll }, "Copy all fields"),
        h("a", { class: "btn", href: `/api/papers/${encodeURIComponent(S.paperId)}/review.md` }, "Download review.md")),
      S.form.fields.map((f) => h("div", { class: "sheet-field" },
        h("h3", {}, f.heading, h("button", { class: "btn small", onclick: () => copyText(P(f.id) || "") }, "Copy")),
        f.type === "choice"
          ? h("select", { onchange: (e) => setP(f.id, e.target.value || null, true) }, h("option", { value: "" }, "— not set —"), f.options.map((o) => h("option", { value: o, selected: P(f.id) === o ? "selected" : null }, o)))
          : textArea(P(f.id) || "", (t) => setP(f.id, t), { focus: "sheet-" + f.id }))));
  },
};

LIVE.wordbar = () => {
  const n = words(P("review"));
  const pct = Math.min(100, Math.round((n / 600) * 100));
  return [h("div", { class: "wordbar" }, h("i", { class: n >= 500 ? "good" : "", style: `width:${pct}%` })),
    h("div", { class: "muted small" }, n < 400 ? `${n} words. Aim for about a page (~500–700 words).` : n <= 900 ? `${n} words. About a page; good.` : `${n} words. Long; check that every part earns its place.`)];
};

function shortOpt(v) { return v.length > 28 ? v.slice(0, 26) + "…" : v; }
function stepOf(q) { return S.flow.steps.find((s) => s.questions.includes(q)).id; }
function novelty(i) { const t = [i.text, i.what, i.why].join(" ").toLowerCase(); return S.flow.lexicons.novelty.some((w) => t.includes(w)); }
function majorMissing(i) {
  const m = ["what", "where", "why", "fix"].filter((k) => !(i[k] || "").trim());
  if (!i.feasible) m.push("feasible");
  if (novelty(i) && !i.novelty_confirmed) m.push("novelty");
  return m;
}
function newItem(p) {
  const it = Object.assign({ id: uid(), type: "minor", dimension: "", location: "", text: "", keep: p.type === "strength", rank: null, dropped: false, source_step: S.pos.step, source_q: null }, p);
  if (it.type === "major") { it.what = it.what || it.text; it.where = it.where || it.location; }
  return it;
}

// ---------------------------------------------------------------- drawer (ledger) & modal
function renderDrawer() {
  const pre = (S.drawer && S.drawer.prefill) || null;
  const fs = flowStep(S.pos.step);
  const f = { type: h("select", {}, ["major", "minor", "strength", "question"].map((t) => h("option", { value: t, selected: (pre?.type || "major") === t ? "selected" : null }, t))),
    dimension: h("select", {}, ["", "soundness", "reproducibility", "clarity", "references", "ethics", "contribution"].map((d) => h("option", { value: d, selected: (pre?.dimension ?? fs.dimension ?? "") === d ? "selected" : null }, d || "(none)"))),
    location: h("input", { type: "text", value: pre?.location || "", placeholder: "Sec. / page / figure" }),
    text: h("textarea", { value: pre?.text || "" }) };
  const add = () => {
    if (!f.text.value.trim()) return;
    ledger().push(newItem({ type: f.type.value, dimension: f.dimension.value, location: f.location.value, text: f.text.value.trim(), source_step: pre?.source_step || S.pos.step, source_q: pre?.source_q || null, rank: ledger().length }));
    S.drawer = { prefill: null }; changed(true);
  };
  const groups = [["strength", "Strengths"], ["major", "Major concerns"], ["minor", "Minor concerns"], ["question", "Questions for the authors"]];
  setTimeout(() => f.text.focus(), 0);
  return h("aside", { class: "drawer" },
    h("button", { class: "btn small close", onclick: () => { S.drawer = null; render(); } }, "Close"),
    h("h2", {}, "Findings ledger"),
    h("p", { class: "muted small" }, "Everything you note here is reused in Steps 8–11, so nothing gets typed twice."),
    h("div", { class: "card" }, h("strong", {}, pre ? "Add this finding" : "Add a finding"),
      h("div", { class: "grid2" }, h("div", {}, h("label", { class: "field" }, "Type"), f.type), h("div", {}, h("label", { class: "field" }, "Dimension"), f.dimension)),
      h("label", { class: "field" }, "Location in the paper"), f.location,
      h("label", { class: "field" }, "Finding"), autogrow(f.text),
      h("div", { class: "inline-actions" }, h("button", { class: "btn primary", onclick: add }, "Add to ledger"))),
    groups.map(([t, label]) => {
      const items = activeLedger(t);
      return items.length ? [h("h3", {}, `${label} (${items.length})`), items.map((i) => h("div", { class: "list-item small" },
        h("div", { class: "row" }, h("span", {}, i.text || i.what, i.location ? h("span", { class: "muted" }, ` (${i.location})`) : null),
          h("button", { class: "btn small danger", onclick: () => { i.dropped = true; changed(true); } }, "Drop"))))] : null;
    }));
}
function renderModal() {
  return h("div", { class: "modal" },
    h("button", { class: "btn small close", onclick: () => { S.modal = null; render(); } }, "Close"),
    h("h2", {}, "About reviewing"),
    Object.values(S.flow.principles).map((p) => h("p", {}, h("strong", {}, p.title + ". "), p.text)),
    h("h3", {}, "IEEE VR 2027 process"), h("ul", {}, S.flow.outcomes.map((o) => h("li", {}, o))),
    h("p", { class: "muted small" }, "Sources: IEEE VR 2027 Call for Papers; CHI 2027 Papers; CHI Guide to Reviewing Papers. This tool is offline: nothing you type leaves this machine."));
}

boot().catch((e) => { $app().replaceChildren(h("div", { class: "start" }, h("div", { class: "note bad" }, "Failed to start: " + e.message))); });
