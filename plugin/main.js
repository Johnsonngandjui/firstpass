/* ═══════════════════════════════════════════════════════════════
   ClipCutter — UI controller + Premiere/helper wiring

   Flow: read the active sequence's source clip (ppro) → POST /analyze
   on the local helper → poll /status → review (word transcript for
   filler/repeats/master, a cut-list for silence) → POST /build_xml →
   project.importFiles() so Premiere assembles the tightened cut as a
   new, fully-editable sequence (UXP has no razor/ripple/delete API,
   so this XML-import path is how the cut actually gets applied).
   ═══════════════════════════════════════════════════════════════ */

const { entrypoints } = require("uxp");
const ppro = require("premierepro");
const HELPER = "http://localhost:7742";
const PROBE_INSERT = false;  // probe done: insert needs the RAW ProjectItem, not the cast ClipProjectItem

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

entrypoints.setup({ panels: { main: { show() {}, hide() {} } } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Apply overlay (the "AI is cutting" animation) ────────────────
function overlayShow(title) {
  const wave = $("#overlay-wave");
  if (wave && !wave.childElementCount) {
    for (let i = 0; i < 40; i++) {
      const b = document.createElement("span");
      b.className = "wbar";
      // deterministic pseudo-waveform (no Math.random needed)
      const h = 8 + Math.round((Math.abs(Math.sin(i * 0.9)) * 0.6 + Math.abs(Math.sin(i * 0.37)) * 0.4) * 34);
      b.style.height = h + "px";
      wave.appendChild(b);
    }
  }
  $("#overlay-title").textContent = title || "Cutting your sequence";
  $("#overlay-sub").textContent = "Preparing edits…";
  $("#overlay-count").textContent = "";
  $("#overlay-progress").style.width = "0%";
  $("#apply-overlay").classList.remove("hidden");
}
function overlayHide() { $("#apply-overlay").classList.add("hidden"); }
function overlayProgress(pct, sub, count) {
  $("#overlay-progress").style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (sub != null) $("#overlay-sub").textContent = sub;
  $("#overlay-count").textContent = count || "";
  const bars = $$("#overlay-wave .wbar");
  const lit = Math.floor(bars.length * pct / 100);
  bars.forEach((b, i) => {
    b.classList.toggle("cut", i < lit);
    b.classList.toggle("scan", i === lit);   // the "playhead" bar
  });
}

// ── Toast ────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", !!isErr);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), isErr ? 6000 : 3200);
}

async function withBusy(btn, busyLabel, fn) {
  if (btn.classList.contains("is-busy")) return;  // controls are <div>, not <button> — guard re-entry with a class
  const orig = btn.textContent;
  btn.classList.add("is-busy");
  btn.setAttribute("aria-disabled", "true");
  btn.textContent = busyLabel;
  try {
    await fn();
  } catch (err) {
    toast(err && err.message ? err.message : String(err), true);
  } finally {
    btn.classList.remove("is-busy");
    btn.removeAttribute("aria-disabled");
    btn.textContent = orig;
  }
}

// ── Sidebar navigation ───────────────────────────────────────────
function showView(name) {
  $$(".view").forEach(v => v.classList.toggle("active", v.dataset.view === name));
  $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view === name));
  // Scope (Selected/Entire) only governs the cut passes — hide it where it's moot.
  const noScope = name === "format" || name === "settings" || name === "review" || name === "flow" || name === "edit";
  const gb = $("#global-bar");
  if (gb) gb.classList.toggle("hidden", noScope);
  $("#content").scrollTop = 0;
}
$$(".nav-item").forEach(btn => btn.addEventListener("click", () => {
  showView(btn.dataset.view);
  if (btn.dataset.view === "format") refreshFormatInfo().catch(() => {});
}));

// ── Toggle switches ──────────────────────────────────────────────
$$(".switch").forEach(sw => sw.addEventListener("click", () => {
  const on = sw.classList.toggle("on");
  sw.setAttribute("aria-pressed", on ? "true" : "false");
}));
function isOn(id) {
  const el = $("#" + id);
  return el ? el.classList.contains("on") : false;
}
function wantsBackup(kind) {
  if (kind === "silence") return isOn("sw-backup-sil");
  if (kind === "repeats") return isOn("sw-backup-rep");
  return false;
}

// ── Segmented controls ───────────────────────────────────────────
$$(".segmented").forEach(group => {
  $$(".seg", group).forEach(seg => seg.addEventListener("click", () => {
    $$(".seg", group).forEach(s => s.classList.remove("active"));
    seg.classList.add("active");
  }));
});
function scopeValue() {
  const a = $('.segmented[data-group="scope"] .seg.active');
  return a ? a.dataset.val : "selected";
}

// ── Filler chips ─────────────────────────────────────────────────
$$("#filler-chips .chip").forEach(chip =>
  chip.addEventListener("click", () => chip.classList.toggle("active"))
);
function selectedFillers() {
  return $$("#filler-chips .chip.active").map(c => c.dataset.word);
}

// ── Format radio cards ───────────────────────────────────────────
$$("#fmt-list .fmt").forEach(card => card.addEventListener("click", () => {
  $$("#fmt-list .fmt").forEach(c => c.classList.remove("active"));
  card.classList.add("active");
}));
function selectedFormat() {
  const a = $("#fmt-list .fmt.active");
  return a ? { w: +a.dataset.w, h: +a.dataset.h } : null;
}

// ── Custom sliders ───────────────────────────────────────────────
// Native <input type=range> renders and behaves inconsistently in UXP (value
// attribute ignored, thumb jumps to extremes), so each slider is a <div> with a
// fill + thumb, driven by mouse events. The current numeric value lives on
// el.value so the rest of the code reads sliders exactly like before.
function bindSlider(id, outId, fmt) {
  const el = $("#" + id);
  if (!el) return;
  const min = +el.dataset.min, max = +el.dataset.max, step = +el.dataset.step || 1;
  const fill = el.querySelector(".slider-fill");
  const thumb = el.querySelector(".slider-thumb");
  const out = outId ? $("#" + outId) : null;

  const clampSnap = (v) => {
    v = Math.min(max, Math.max(min, v));
    v = Math.round((v - min) / step) * step + min;
    return Math.min(max, Math.max(min, +v.toFixed(6)));
  };

  function render() {
    const v = +el.value;
    const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
    fill.style.width = pct + "%";
    thumb.style.left = pct + "%";
    if (out) out.textContent = fmt(v);
  }

  function setFromClientX(clientX) {
    const r = el.getBoundingClientRect();
    const pct = r.width > 0 ? (clientX - r.left) / r.width : 0;
    el.value = clampSnap(min + pct * (max - min));
    render();
  }

  el.value = clampSnap(+el.dataset.value);   // establish the intended default
  render();

  let dragging = false;
  const onMove = (e) => { if (dragging) setFromClientX(e.clientX); };
  const onUp   = () => {
    dragging = false;
    el.classList.remove("dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  el.addEventListener("mousedown", (e) => {
    dragging = true;
    el.classList.add("dragging");
    setFromClientX(e.clientX);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });
  // keyboard nudge
  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown")  { el.value = clampSnap(+el.value - step); render(); }
    if (e.key === "ArrowRight" || e.key === "ArrowUp")   { el.value = clampSnap(+el.value + step); render(); }
  });
}
const dB = v => { const n = Math.round(v); return (n < 0 ? "−" : "") + Math.abs(n) + " dB"; };
bindSlider("sil-thresh", "sil-thresh-val", dB);
bindSlider("sil-dur",    "sil-dur-val",    v => v.toFixed(2) + " s");
bindSlider("sens",       "sens-val",       v => v < 34 ? "Low" : v < 67 ? "Balanced" : "High");

// Smart dead-air ignores the dB threshold — dim the slider so that's obvious.
function syncSmartUI() {
  const tf = $("#thresh-field");
  if (tf) tf.classList.toggle("dimmed", isOn("sw-smart-silence"));
}
{
  const smartSw = $("#sw-smart-silence");
  if (smartSw) smartSw.addEventListener("click", () => setTimeout(syncSmartUI, 0));
  syncSmartUI();
}

// Sensitivity 0-100 -> repeat-match similarity threshold (higher sensitivity = lower threshold = catches more)
function sensSimilarity() {
  const el = $("#sens");
  const v = el ? +el.value : 60;
  return +(0.92 - (v / 100) * 0.22).toFixed(3);
}

// ── Formatting helpers ───────────────────────────────────────────
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}
function formatDur(sec) {
  return sec >= 1 ? `${sec.toFixed(1)}s` : `${Math.round(sec * 1000)}ms`;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Premiere: read the active sequence's source clip ─────────────
async function getSequenceInfo() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence — open one in the timeline.");

  const CLIP = ppro.Constants?.TrackItemType?.Clip ?? 1;

  // Gather clips across ALL video tracks (not just V1) so a selection on any
  // track is found.
  let vCount = 1;
  try { vCount = await sequence.getVideoTrackCount(); } catch (_) {}
  const items = [];
  for (let vt = 0; vt < vCount; vt++) {
    const trk = await sequence.getVideoTrack(vt).catch(() => null);
    if (!trk) continue;
    for (const it of (await trk.getTrackItems(CLIP, false) || [])) items.push(it);
  }
  if (!items.length) throw new Error("No clips found on any video track.");

  let target = items[0];
  if (scopeValue() === "selected") {
    let found = null;
    for (const it of items) {
      try { if (await it.getIsSelected()) { found = it; break; } } catch (_) {}
    }
    if (!found) throw new Error("No clip selected — select a clip, or switch to “Entire sequence”.");
    target = found;
  }

  const clipItem = ppro.ClipProjectItem.cast(await target.getProjectItem());
  if (!clipItem) throw new Error("Could not resolve the source clip's project item.");
  const mediaPath = await clipItem.getMediaFilePath();

  let duration = null;
  try {
    const out = await sequence.getOutPoint();
    const inP = await sequence.getInPoint();
    if (out) duration = out.seconds - (inP?.seconds ?? 0);
  } catch (_) {}

  return { project, sequence, seqName: sequence.name, mediaPath, duration };
}

// Gather the source ranges of every clip the cut will target (scope + media
// match). Cached so review counts can update synchronously as cuts toggle.
let clipMetas = [];
async function gatherClipMetas(mp) {
  clipMetas = [];
  try {
    const project = await ppro.Project.getActiveProject();
    const sequence = project && await project.getActiveSequence();
    if (!sequence) return;
    const CLIP = ppro.Constants?.TrackItemType?.Clip ?? 1;
    const selMode = scopeValue() === "selected";
    let vCount = 1; try { vCount = await sequence.getVideoTrackCount(); } catch (_) {}
    for (let vt = 0; vt < vCount; vt++) {
      const trk = await sequence.getVideoTrack(vt).catch(() => null);
      if (!trk) continue;
      for (const it of (await trk.getTrackItems(CLIP, false) || [])) {
        let include = !selMode;
        if (selMode) { try { include = await it.getIsSelected(); } catch (_) { include = false; } }
        if (!include) continue;
        let itMp = null, si = 0, du = 0;
        try { const rc = ppro.ClipProjectItem.cast(await it.getProjectItem()); itMp = rc ? await rc.getMediaFilePath() : null; } catch (_) {}
        if (mp && itMp && itMp !== mp) continue;
        try { const p = await it.getInPoint();  si = p ? p.seconds : 0; } catch (_) {}
        try { const d = await it.getDuration(); du = d ? d.seconds : 0; } catch (_) {}
        clipMetas.push({ si, du });
      }
    }
  } catch (_) {}
}

// Real on-timeline totals for a set of cuts: for each target clip, count only
// the cuts inside ITS source range (clips can be trimmed differently) and sum.
// Matches exactly what Apply does — synchronous, uses the cached clip metas.
function multiClipTotals(cuts) {
  if (!clipMetas.length) {
    return { count: cuts.length, clips: 1,
      removableSec: cuts.reduce((s, c) => s + (c.endSec - c.startSec), 0) };
  }
  let count = 0, removable = 0;
  for (const m of clipMetas) {
    for (const c of cuts) {
      if (c.endSec > m.si + 0.01 && c.startSec < m.si + m.du - 0.01) {
        count++;
        const s = Math.max(c.startSec, m.si), e = Math.min(c.endSec, m.si + m.du);
        removable += Math.max(0, e - s);
      }
    }
  }
  return { count, removableSec: removable, clips: clipMetas.length };
}

// ── Helper: analyze (POST + poll) ─────────────────────────────────
async function startAndPoll(params) {
  const startResp = await fetch(`${HELPER}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });
  if (!startResp.ok) {
    const e = await startResp.json().catch(() => ({}));
    throw new Error(e.detail || "Helper returned an error.");
  }
  const { job_id } = await startResp.json();

  while (true) {
    await new Promise(r => setTimeout(r, 700));
    const s = await fetch(`${HELPER}/status/${job_id}`);
    const status = await s.json();
    if (status.state === "done") return status;
    if (status.state === "error") throw new Error(status.message || "Unknown helper error.");
  }
}

// ── State ────────────────────────────────────────────────────────
let allCuts = [];          // cuts relevant to currentKind only
let allWords = [];
let mediaDuration = null;
let mediaPath = null;
let currentKind = "silence";
let reviewOrigin = "silence";

function filterByKind(kind, cuts) {
  if (kind === "filler")  return cuts.filter(c => c.type === "filler");
  if (kind === "repeats") return cuts.filter(c => c.type === "repeated_take");
  if (kind === "silence") return cuts.filter(c => c.type === "silence");
  if (kind === "master")  return isOn("m-silence") ? cuts : cuts.filter(c => c.type !== "silence");
  return cuts;
}

async function runAnalyze(kind) {
  const info = await getSequenceInfo();
  mediaPath = info.mediaPath;

  const padBefore = parseFloat($("#pad-before")?.value ?? "0.1") || 0;
  const padAfter  = parseFloat($("#pad-after")?.value ?? "0.1") || 0;
  const paddingMs = Math.round(((padBefore + padAfter) / 2) * 1000);

  const wantsFiller  = kind === "filler"  || (kind === "master" && isOn("m-filler"));
  const wantsRepeats = kind === "repeats" || (kind === "master" && isOn("m-repeats"));
  // "Smart dead-air" needs a transcript for speech-gap detection.
  const wantsSilence = kind === "silence" || (kind === "master" && isOn("m-silence"));
  const smart        = isOn("sw-smart-silence");
  const wantsWords   = wantsFiller || wantsRepeats || (wantsSilence && smart);

  const params = {
    media_paths:    [mediaPath],
    seq_name:       info.seqName,
    silence_db:     parseFloat($("#sil-thresh").value),
    silence_dur:    parseFloat($("#sil-dur").value),
    padding_ms:     paddingMs,
    detect_silence: wantsSilence,   // filler/repeats-only passes must NOT emit silence cuts
    remove_fillers: wantsFiller,
    detect_takes:   wantsRepeats,
    transcribe:     wantsWords,
    similarity:     sensSimilarity(),
    fillers:        wantsFiller ? selectedFillers() : null,   // the chips you picked
    keep_last:      isOn("sw-keep-last"),                      // Repeats: keep last vs first take
    smart_silence:  smart,
    auto_threshold: smart
  };

  const status = await startAndPoll(params);
  allCuts = filterByKind(kind, status.cuts || []);
  allWords = status.words || [];
  mediaDuration = status.duration ?? mediaDuration;
  currentKind = kind;
  lastAnalysis = status;   // keep loudness/method for the stats readout
  await gatherClipMetas(mediaPath);   // clip source ranges for real per-clip totals
}

let lastAnalysis = null;
function updateSilenceStats() {
  const t = multiClipTotals(allCuts);
  $("#sil-count").textContent = t.clips > 1 ? `${t.count}  (across ${t.clips} clips)` : String(t.count);
  $("#sil-removable").textContent = formatDur(t.removableSec);
  const det = $("#sil-detect");
  if (det && lastAnalysis) {
    const m = lastAnalysis.silence_method;
    const lvl = lastAnalysis.mean_db != null ? `${Math.round(lastAnalysis.mean_db)} dB avg` : "";
    det.textContent = m === "speech-gaps" ? `Speech gaps · ${lvl}`
      : m === "auto-threshold" ? `Auto ${lastAnalysis.suggested_db} dB · ${lvl}`
      : `Fixed ${Math.round(parseFloat($("#sil-thresh").value))} dB`;
  }
}

// ── Review: word transcript (filler / repeats / master) ──────────
function buildWordClassMap() {
  const cuts = allCuts
    .filter(c => c.type === "filler" || c.type === "repeated_take")
    .slice().sort((a, b) => a.startSec - b.startSec);

  const idxToCut = new Array(allWords.length).fill(null);
  let ci = 0;
  for (let i = 0; i < allWords.length; i++) {
    const w = allWords[i];
    while (ci < cuts.length && cuts[ci].endSec <= w.start) ci++;
    if (ci < cuts.length && w.start >= cuts[ci].startSec && w.start < cuts[ci].endSec) {
      idxToCut[i] = cuts[ci];
    }
  }

  // Decorative "kept take" highlight: right after an enabled repeated_take
  // cut, mark the next same-length run of un-cut words as the retained take.
  const decorative = new Set();
  const seen = new Set();
  for (let i = 0; i < allWords.length; i++) {
    const cut = idxToCut[i];
    if (!cut || cut.type !== "repeated_take" || !cut.enabled || seen.has(cut.id)) continue;
    seen.add(cut.id);
    let j = i;
    while (j < allWords.length && idxToCut[j] === cut) j++;
    const len = j - i;
    let k = j, count = 0;
    while (k < allWords.length && count < len) {
      if (!idxToCut[k]) { decorative.add(k); count++; }
      k++;
    }
  }
  return { idxToCut, decorative };
}

function renderWordTranscript() {
  const box = $("#transcript");
  box.classList.toggle("no-highlight", !isOn("sw-highlight"));   // "Highlight in transcript" toggle
  if (!allWords.length) {
    box.innerHTML = '<p style="color:var(--text-mute);">No transcript available — run Analyze first.</p>';
    return;
  }
  const { idxToCut, decorative } = buildWordClassMap();
  // Only wrap HIGHLIGHTED words in a <span>; leave untouched words as plain text.
  // A 10-min clip has ~2000 words — a span each makes the scroll container crawl
  // in UXP. Plain text collapses the untouched runs into cheap text nodes.
  const parts = allWords.map((w, i) => {
    const cut = idxToCut[i];
    const text = escapeHtml(w.word);
    if (cut) {
      const cls = cut.enabled ? "rm" : "kept-manual";
      return `<span class="w ${cls}" data-cut-id="${cut.id}">${text}</span>`;
    }
    if (decorative.has(i)) return `<span class="w keep">${text}</span>`;
    return text;   // untouched → plain text, no element
  });
  box.innerHTML = `<p>${parts.join(" ")}</p>`;
}

// ── Review: cut list (silence — no words to anchor to) ────────────
function renderCutList() {
  const list = $("#cutlist");
  const sorted = allCuts.slice().sort((a, b) => a.startSec - b.startSec);
  list.innerHTML = "";
  if (sorted.length === 0) {
    list.innerHTML = '<div style="color:var(--text-mute);font-size:12px;text-align:center;padding:14px 0;">No silences found.</div>';
    return;
  }
  for (const c of sorted) {
    const row = document.createElement("div");
    row.className = "cut-row" + (c.enabled ? "" : " off");
    row.innerHTML =
      `<span class="cr-dot"></span>` +
      `<span class="cr-time">${formatTime(c.startSec)} → ${formatTime(c.endSec)}</span>` +
      `<span class="cr-dur">−${formatDur(c.endSec - c.startSec)}</span>`;
    row.addEventListener("click", () => { c.enabled = !c.enabled; renderCutList(); updateReviewCounts(); });
    list.appendChild(row);
  }
}

function updateReviewCounts() {
  const enabled = allCuts.filter(c => c.enabled);
  // real totals across every target clip (not just the analyzed media)
  const t = multiClipTotals(enabled);
  const mm = Math.floor(t.removableSec / 60), ss = Math.round(t.removableSec % 60);
  $("#savings-val").textContent = `${mm}:${String(ss).padStart(2, "0")}`;

  const suffix = t.clips > 1 ? ` (${t.clips} clips)` : "";

  if (currentKind === "master") {
    // Master removes all three types — show a per-type breakdown, not just "repeats".
    const cntOf = (type) => multiClipTotals(enabled.filter(c => c.type === type)).count;
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const r = cntOf("repeated_take"), f = cntOf("filler"), s = cntOf("silence");
    const parts = [];
    if (r) parts.push(plural(r, "repeat"));
    if (f) parts.push(plural(f, "filler"));
    if (s) parts.push(plural(s, "silence"));
    $("#repeats-found").textContent = parts.length
      ? `${parts.join(" · ")} found${suffix}`
      : "Nothing to remove";
  } else {
    const noun = currentKind === "filler" ? "filler word" : currentKind === "silence" ? "silence" : "repeat";
    const n = t.count;
    $("#repeats-found").textContent = `${n} ${noun}${n === 1 ? "" : "s"} found${suffix}`;
  }
}

function renderReview() {
  const useWords = currentKind !== "silence";
  $("#transcript").classList.toggle("hidden", !useWords);
  $("#cutlist").classList.toggle("hidden", useWords);
  if (useWords) renderWordTranscript(); else renderCutList();
  updateReviewCounts();
}

function openReview(kind) {
  currentKind = kind;
  reviewOrigin = kind;
  renderReview();
  showView("review");
}

// Click a highlighted word to toggle its cut on/off
$("#transcript").addEventListener("click", (e) => {
  const w = e.target.closest(".w[data-cut-id]");
  if (!w) return;
  const cut = allCuts.find(c => c.id === w.dataset.cutId);
  if (!cut) return;
  cut.enabled = !cut.enabled;
  renderReview();
});

$("#review-back").addEventListener("click", () => showView(reviewOrigin));
$("#keep-all").addEventListener("click", () => {
  allCuts.forEach(c => c.enabled = false);
  renderReview();
  toast("All kept — nothing will be removed.");
});
$("#remove-hl").addEventListener("click", () =>
  withBusy($("#remove-hl"), "Applying…", () => applyCuts(currentKind))
);

// Invert cut ranges → keep ranges over [0, total], in source-media seconds.
function invertCuts(cuts, total) {
  const sorted = cuts.slice().sort((a, b) => a.startSec - b.startSec);
  const keeps = [];
  let cur = 0;
  for (const c of sorted) {
    if (c.startSec > cur + 0.001) keeps.push({ start: cur, end: c.startSec });
    cur = Math.max(cur, c.endSec);
  }
  if (cur < total - 0.001) keeps.push({ start: cur, end: total });
  return keeps.filter(k => k.end - k.start > 0.02);
}

// Rebuild the ACTIVE sequence's V1/A1 as the tightened cut, using the real
// SequenceEditor API (Premiere 26 has no razor, so we can't split-and-delete —
// we place the kept segments, then ripple-remove the original). Strategy:
//   1. pre-flight every required method — abort BEFORE touching anything if any is absent
//   2. place kept segments AFTER the original (additive — original stays intact if this fails)
//   3. ripple-remove the original items → the kept segments collapse to start at 0
// Returns { ok, segments } or { ok:false, missing:[...] } / throws with the exact failing call.
async function rebuildInPlace(app, project, sequence, cuts, ripple, onStep) {
  // phase is updated before EVERY call so a thrown error (even an unlabeled
  // native one) tells us exactly which call blew up. rebuildInPlace's caller
  // posts `phaseRef.v` alongside the error.
  const P = { v: "start" };
  const step = onStep || (() => {});
  try {
    const SE  = app.SequenceEditor;
    const TIS = app.TrackItemSelection;
    const mkTT = app.TickTime && app.TickTime.createWithSeconds
      ? (s) => app.TickTime.createWithSeconds(s) : null;

    const CLIP = app.Constants?.TrackItemType?.Clip ?? 1;   // .Clip is undefined on this build → fall back to 1 (what getTrackItems accepts)

    P.v = "getEditor"; const editor = (SE && typeof SE.getEditor === "function") ? SE.getEditor(sequence) : null;
    const selMode = scopeValue() === "selected";

    // editor-level pre-flight (per-clip checks happen in the loop)
    const missing = [];
    if (!editor) missing.push("SequenceEditor.getEditor");
    if (!TIS || typeof TIS.createEmptySelection !== "function") missing.push("TrackItemSelection.createEmptySelection");
    if (!mkTT) missing.push("TickTime.createWithSeconds");
    if (editor && typeof editor.createOverwriteItemAction !== "function") missing.push("editor.createOverwriteItemAction");
    if (editor && typeof editor.createRemoveItemsAction !== "function") missing.push("editor.createRemoveItemsAction");
    if (!mediaDuration) missing.push("media duration (run Analyze first)");
    if (missing.length) return { ok: false, missing };

    P.v = "track counts";
    let vCount = 1, aCount = 0;
    try { vCount = await sequence.getVideoTrackCount(); } catch (_) {}
    try { aCount = await sequence.getAudioTrackCount(); } catch (_) {}

    // Constants.MediaType keys are UPPERCASE on this build (ANY/DATA/VIDEO/AUDIO).
    const MTenum = (app.Constants && app.Constants.MediaType) || {};
    const MT = MTenum.ANY ?? MTenum.Any ?? MTenum.VIDEO ?? Object.values(MTenum)[0];

    // ── Collect the TARGET clips: ALL clips for "Entire sequence", or every
    //    SELECTED clip for "Selected clips" — across every video track, limited
    //    to clips of the analyzed media. Each gets its own position mapping. ──
    P.v = "collect clips";
    const clipsMeta = [];
    for (let vt = 0; vt < vCount; vt++) {
      const trk = await sequence.getVideoTrack(vt).catch(() => null);
      if (!trk) continue;
      for (const it of (await trk.getTrackItems(CLIP, false) || [])) {
        let include = !selMode;
        if (selMode) { try { include = await it.getIsSelected(); } catch (_) { include = false; } }
        if (!include) continue;

        let rawIt = null, srcC = null, mp = null;
        try { rawIt = await it.getProjectItem(); } catch (_) {}
        srcC = rawIt ? app.ClipProjectItem.cast(rawIt) : null;
        try { mp = srcC ? await srcC.getMediaFilePath() : null; } catch (_) {}
        // only cut clips of the media we analyzed
        if (mediaPath && mp && mp !== mediaPath) continue;
        if (!srcC || typeof srcC.createSetInOutPointsAction !== "function") continue;

        let cs = 0, ci = 0, cd = 0;
        try { const s = await it.getStartTime(); cs = s ? s.seconds : 0; } catch (_) {}
        try { const p = await it.getInPoint();   ci = p ? p.seconds : 0; } catch (_) {}
        try { const d = await it.getDuration();  cd = d ? d.seconds : 0; } catch (_) {}
        clipsMeta.push({ vIndex: vt, clipStart: cs, clipSourceIn: ci, clipDur: cd, rawItem: rawIt, srcClip: srcC });
      }
    }
    if (!clipsMeta.length) return { ok: false, missing: [selMode ? "a selected clip of this media" : "clips of this media"] };
    // Process right-to-left: a ripple shifts content to the RIGHT of the cut, so
    // a clip's own start stays valid while clips to its right are handled first.
    clipsMeta.sort((a, b) => b.clipStart - a.clipStart);

    const cutsDesc = cuts.slice().sort((a, b) => b.startSec - a.startSec);

    const findAt = async (track, sec) => {
      const its = track ? await track.getTrackItems(CLIP, false) : [];
      for (const it of (its || [])) {
        let st = -1;
        try { const x = await it.getStartTime(); st = x ? x.seconds : -1; } catch (_) {}
        if (Math.abs(st - sec) < 0.05) return it;
      }
      return null;
    };
    // Apply a cut to a clip only if its WHOLE source range fits inside that
    // clip's trimmed range. A cut that overlaps a clip but spills past its edge
    // means this media was already split into fragments by an earlier pass (e.g.
    // Silence removal) — the cut times are in ORIGINAL media time and would map
    // to the wrong spot, so we must NOT apply it. Count those so we can warn.
    const fitsClip = (cu, m) =>
      cu.startSec >= m.clipSourceIn - 0.05 && cu.endSec <= m.clipSourceIn + m.clipDur + 0.05;
    const overlapsClip = (cu, m) =>
      cu.endSec > m.clipSourceIn + 0.01 && cu.startSec < m.clipSourceIn + m.clipDur - 0.01;
    const cutsInClip = (m) => cutsDesc.filter(cu => fitsClip(cu, m));
    let spanningCuts = 0;   // overlap some clip but fit in none → fragmented timeline
    for (const cu of cutsDesc) {
      if (!clipsMeta.some(m => fitsClip(cu, m)) && clipsMeta.some(m => overlapsClip(cu, m)))
        spanningCuts++;
    }
    const totalWork = clipsMeta.reduce((n, m) => n + cutsInClip(m).length, 0) || 1;
    const perDelay = Math.max(45, Math.min(280, Math.round(3000 / totalWork)));

    // ── For each target clip (right-to-left), ripple-delete each silence inside
    //    it (back-to-front). CUT (split out) → DELETE+SHIFT (removeItems ripple). ──
    let removed = 0, done = 0, skipped = 0, clipNo = 0;
    for (const m of clipsMeta) {
      clipNo++;
      const { srcClip, rawItem, vIndex } = m;
      for (const cut of cutsInClip(m)) {
        const s = cut.startSec, e = cut.endSec;
        const ts = m.clipStart + (s - m.clipSourceIn);   // media-time → this clip's timeline pos

        P.v = `setInOut(${s.toFixed(2)},${e.toFixed(2)})`;
        await project.lockedAccess(() => {
          project.executeTransaction((c) => {
            c.addAction(srcClip.createSetInOutPointsAction(mkTT(s), mkTT(e)));
          }, "ClipCutter: in/out");
        });
        P.v = `split(ts=${ts.toFixed(2)},v=${vIndex})`;
        await project.lockedAccess(() => {
          project.executeTransaction((c) => {
            c.addAction(editor.createOverwriteItemAction(rawItem, mkTT(ts), vIndex, vIndex));
          }, "ClipCutter: split silence");
        });

        P.v = `find@${ts.toFixed(2)}`;
        const targets = [];
        const vHit = await findAt(await sequence.getVideoTrack(vIndex).catch(() => null), ts);
        if (vHit) targets.push(vHit);
        for (let t = 0; t < aCount; t++) {
          const at = await sequence.getAudioTrack(t).catch(() => null);
          const aHit = at ? await findAt(at, ts) : null;
          if (aHit) targets.push(aHit);
        }

        if (targets.length) {
          P.v = `ripple-delete@${ts.toFixed(2)}`;
          await project.lockedAccess(() => {
            let sel = null;
            TIS.createEmptySelection((x) => { sel = x; });
            if (!sel) return;
            for (const it of targets) sel.addItem(it, true);
            project.executeTransaction((c) => {
              // shiftOverLapping=false → following clips slide over to close the gap
              const a = editor.createRemoveItemsAction(sel, !!ripple, MT, false);
              if (a) c.addAction(a);
            }, "ClipCutter: ripple-delete silence");
          });
          removed++;
        } else { skipped++; }

        done++;
        const label = clipsMeta.length > 1 ? `Clip ${clipNo}/${clipsMeta.length} · cut ${done}` : `Cutting silence ${done} of ${totalWork}`;
        step(6 + done / totalWork * 94, label, `${done} / ${totalWork}`);
        await sleep(perDelay);
      }
    }

    step(100, "Done", "");
    await sleep(200);

    return { ok: true, segments: removed, clips: clipsMeta.length, spanningCuts };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    const err = new Error(`phase=${P.v} :: ${msg}`);
    err._phase = P.v;
    throw err;
  }
}

// ── Apply: edit the ACTIVE sequence in place (never create a new one) ──────
async function applyCuts(kind) {
  const enabled = allCuts.filter(c => c.enabled)
                         .slice().sort((a, b) => a.startSec - b.startSec);
  if (enabled.length === 0) throw new Error("Nothing selected to remove.");

  // Target the current timeline directly.
  const app      = ppro;
  const project  = await app.Project.getActiveProject();
  if (!project) throw new Error("No active project open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence — open your timeline.");

  // "Backup sequence first" is the ONLY thing that may clone — off by default,
  // so nothing new is created unless you explicitly ask for it.
  if (wantsBackup(kind) && typeof sequence.createCloneAction === "function") {
    await project.lockedAccess(() => {
      project.executeTransaction((c) => c.addAction(sequence.createCloneAction()),
                                 "ClipCutter: backup sequence");
    });
  }

  // "Ripple delete gaps" is silence-specific; for filler/repeats we always
  // ripple (leaving gaps where words were removed would be odd).
  const ripple = (kind === "silence") ? isOn("sw-ripple") : true;

  overlayShow("Cutting your sequence");
  overlayProgress(4, "Reading edits…", "");

  let result;
  try {
    result = await rebuildInPlace(app, project, sequence, enabled, ripple,
      (pct, sub, count) => overlayProgress(pct, sub, count));
  } catch (err) {
    overlayHide();
    throw new Error((err && err.message) ? err.message : String(err));
  }

  overlayHide();

  if (result.ok) {
    // Some cuts couldn't be placed because this media is already split into
    // fragments (a previous pass edited the timeline). Warn instead of silently
    // mis-cutting — the fix is to run transcript passes (fillers/repeats) BEFORE
    // removing silence, or use Master to do everything in one pass.
    if (result.spanningCuts > 0) {
      toast(`Skipped ${result.spanningCuts} cut${result.spanningCuts === 1 ? "" : "s"} — this clip was already split (e.g. by Silence). Run Fillers/Repeats BEFORE Silence, or use Master.`, true);
    } else {
      const savedSec = enabled.reduce((s, c) => s + (c.endSec - c.startSec), 0);
      const n = result.clips > 1 ? `${result.clips} clips` : `"${sequence.name}"`;
      toast(`Cut ${n} in place · ${result.segments} sections removed · −${formatDur(savedSec)}`);
    }
    showView(reviewOrigin);
    return;
  }

  // Couldn't run — report exactly which primitive is missing (nothing was changed).
  throw new Error("In-place cut unavailable — missing: " + result.missing.join(", "));
}

// ── Assemble engine: rebuild the active sequence in a NEW segment order ──────
// Reordering can't be a ripple-delete — we re-assemble from the SOURCE media.
// Strategy (avoids the "position past end → Invalid" wall):
//   1. read the source ProjectItem + the timeline's current extent
//   2. overwrite each ordered segment onto the timeline at a running position,
//      all WITHIN the existing extent (overwrite replaces whatever was there)
//   3. ripple-remove any leftover tail past the new assembly
// orderedSegs: [{start,end}] in SOURCE-media seconds, already in the target order.
async function assembleReorder(app, project, sequence, orderedSegs, onStep) {
  const P = { v: "start" };
  const step = onStep || (() => {});
  try {
    const SE  = app.SequenceEditor;
    const TIS = app.TrackItemSelection;
    const mkTT = (s) => app.TickTime.createWithSeconds(s);
    const CLIP = app.Constants?.TrackItemType?.Clip ?? 1;
    const MTenum = (app.Constants && app.Constants.MediaType) || {};
    const MT = MTenum.ANY ?? Object.values(MTenum)[0];

    P.v = "getEditor";
    const editor = (SE && typeof SE.getEditor === "function") ? SE.getEditor(sequence) : null;
    const missing = [];
    if (!editor || typeof editor.createOverwriteItemAction !== "function") missing.push("editor.createOverwriteItemAction");
    if (!editor || typeof editor.createRemoveItemsAction !== "function") missing.push("editor.createRemoveItemsAction");
    if (!app.TickTime || typeof app.TickTime.createWithSeconds !== "function") missing.push("TickTime.createWithSeconds");
    if (missing.length) return { ok: false, missing };

    P.v = "track counts";
    let vCount = 1, aCount = 0;
    try { vCount = await sequence.getVideoTrackCount(); } catch (_) {}
    try { aCount = await sequence.getAudioTrackCount(); } catch (_) {}

    // Source clip of the analyzed media (RAW ProjectItem needed for overwrite) +
    // its video-track index + the current timeline extent.
    P.v = "find source";
    let rawItem = null, srcClip = null, vIndex = 0, origEnd = 0;
    for (let vt = 0; vt < vCount; vt++) {
      const trk = await sequence.getVideoTrack(vt).catch(() => null);
      if (!trk) continue;
      for (const it of (await trk.getTrackItems(CLIP, false) || [])) {
        let st = 0, du = 0;
        try { const s = await it.getStartTime(); st = s ? s.seconds : 0; } catch (_) {}
        try { const d = await it.getDuration();  du = d ? d.seconds : 0; } catch (_) {}
        origEnd = Math.max(origEnd, st + du);
        if (!rawItem) {
          let ri = null, sc = null, mp = null;
          try { ri = await it.getProjectItem(); } catch (_) {}
          sc = ri ? app.ClipProjectItem.cast(ri) : null;
          try { mp = sc ? await sc.getMediaFilePath() : null; } catch (_) {}
          if (!mediaPath || !mp || mp === mediaPath) { rawItem = ri; srcClip = sc; vIndex = vt; }
        }
      }
    }
    if (!rawItem || !srcClip) return { ok: false, missing: ["source clip of the analyzed media"] };
    if (typeof srcClip.createSetInOutPointsAction !== "function") return { ok: false, missing: ["ClipProjectItem.createSetInOutPointsAction"] };

    // ── Lay each segment (new order) at a running position within the extent ──
    P.v = "assemble";
    const total = orderedSegs.length || 1;
    let pos = 0, n = 0;
    for (const seg of orderedSegs) {
      const inS = seg.start, outS = seg.end, len = Math.max(0, outS - inS);
      if (len <= 0.03) continue;
      P.v = `setInOut(${inS.toFixed(2)},${outS.toFixed(2)})`;
      await project.lockedAccess(() => {
        project.executeTransaction((c) => {
          c.addAction(srcClip.createSetInOutPointsAction(mkTT(inS), mkTT(outS)));
        }, "ClipCutter: segment in/out");
      });
      P.v = `overwrite@${pos.toFixed(2)}(v=${vIndex})`;
      await project.lockedAccess(() => {
        project.executeTransaction((c) => {
          c.addAction(editor.createOverwriteItemAction(rawItem, mkTT(pos), vIndex, 0));
        }, "ClipCutter: place segment");
      });
      pos += len; n++;
      step(6 + (n / total) * 80, `Placing segment ${n} of ${total}`, `${n} / ${total}`);
      await sleep(140);
    }
    const assemblyLen = pos;

    // ── Trim the leftover tail (old content beyond the new assembly) ──────────
    if (origEnd > assemblyLen + 0.05) {
      P.v = `trim-tail@${assemblyLen.toFixed(2)}`;
      const findTail = async (track) => {
        const out = [];
        for (const it of (track ? await track.getTrackItems(CLIP, false) : []) || []) {
          let st = -1; try { const x = await it.getStartTime(); st = x ? x.seconds : -1; } catch (_) {}
          if (st >= assemblyLen - 0.02) out.push(it);
        }
        return out;
      };
      await project.lockedAccess(async () => {
        const tail = [];
        for (let vt = 0; vt < vCount; vt++) tail.push(...await findTail(await sequence.getVideoTrack(vt).catch(() => null)));
        for (let at = 0; at < aCount; at++) tail.push(...await findTail(await sequence.getAudioTrack(at).catch(() => null)));
        if (!tail.length) return;
        let sel = null;
        TIS.createEmptySelection((x) => { sel = x; });
        if (!sel) return;
        for (const it of tail) sel.addItem(it, true);
        project.executeTransaction((c) => {
          const a = editor.createRemoveItemsAction(sel, true, MT, false);
          if (a) c.addAction(a);
        }, "ClipCutter: trim tail");
      });
    }

    step(100, "Done", "");
    await sleep(180);
    return { ok: true, placed: n, seconds: assemblyLen };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    const err = new Error(`phase=${P.v} :: ${msg}`);
    err._phase = P.v;
    throw err;
  }
}

// Apply the AI-Flow topic order to the timeline (re-assemble).
async function applyReorder() {
  if (!flowPlan || !flowSegs || !flowPlan.order || !flowPlan.order.length)
    throw new Error("No arranged story to apply — run “Arrange story” first.");

  // A segment's [start,end] SPANS the gaps Master removed (silences, fillers,
  // earlier repeat takes). Placing the whole span from source would re-introduce
  // that removed content and undo Master's cuts. So expand each segment into only
  // its KEPT spans — the ranges left after subtracting the enabled cuts.
  const cuts = allCuts.filter(c => c.enabled).slice().sort((a, b) => a.startSec - b.startSec);
  const keptWithin = (s, e) => {
    const spans = []; let cur = s;
    for (const c of cuts) {
      if (c.endSec <= s || c.startSec >= e) continue;      // no overlap with this segment
      if (c.startSec > cur) spans.push({ start: cur, end: Math.min(c.startSec, e) });
      cur = Math.max(cur, c.endSec);
    }
    if (cur < e) spans.push({ start: cur, end: e });
    return spans.filter(sp => sp.end - sp.start > 0.03);
  };

  const orderedSegs = [];
  for (const id of flowPlan.order) {
    const s = flowSegs.find(x => x.id === id);
    if (!s) continue;
    for (const sp of keptWithin(s.start, s.end)) orderedSegs.push(sp);
  }
  if (!orderedSegs.length) throw new Error("Nothing to assemble.");

  const app = ppro;
  const project = await app.Project.getActiveProject();
  if (!project) throw new Error("No active project open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence — open your timeline.");

  overlayShow("Reassembling your story");
  overlayProgress(4, "Reading the new order…", "");

  let result;
  try {
    result = await assembleReorder(app, project, sequence, orderedSegs,
      (pct, sub, count) => overlayProgress(pct, sub, count));
  } catch (err) {
    overlayHide();
    throw new Error((err && err.message) ? err.message : String(err));
  }
  overlayHide();

  if (result.ok) {
    toast(`Reassembled in the new order · ${result.placed} segments. (Cmd+Z to undo.)`);
    return;
  }
  throw new Error("Reorder unavailable — missing: " + result.missing.join(", "));
}

// Find sequence-level range-edit methods actually present on this build, ranked
// by how well they fit "excise a time window and ripple-collapse the timeline".
// (The exact name varies by build, so we discover it instead of hardcoding one.)
function rangeEditCandidates(sequence, report) {
  const names = (report && report.sequence) ? report.sequence : listAllMethods(sequence);
  const rank = (n) => {
    const s = n.toLowerCase();
    if (s.includes("ripple") && s.includes("range"))  return 0;  // ideal: ripple-delete a range
    if (s.includes("ripple") && s.includes("delete")) return 1;
    if (s.includes("extract"))                        return 2;  // extract = lift + ripple
    if (s.includes("delete") && s.includes("range"))  return 3;
    if (s.includes("remove") && s.includes("range"))  return 4;
    if (s.includes("clear")  && s.includes("range"))  return 5;
    if (s.includes("lift"))                           return 6;  // last resort: leaves a gap
    return 99;
  };
  return names
    .filter(n => typeof sequence[n] === "function" && /^create/i.test(n) &&
      (/ripple|extract|lift/i.test(n) || /(delete|remove|clear).*range|range.*(delete|remove|clear)/i.test(n)))
    .filter(n => rank(n) < 99)
    .sort((a, b) => rank(a) - rank(b));
}

// Attempt an in-place ripple delete using whatever real API the build exposes.
// Returns { count, method } on success, or { count: null, tried } if nothing worked.
// Each candidate is tried in its own transaction with try/catch, so a wrong
// signature aborts that attempt cleanly rather than corrupting the timeline.
async function rippleDeleteInPlace(app, project, sequence, cuts, report, opts = {}) {
  const TT = app.TickTime && typeof app.TickTime.createWithSeconds === "function"
    ? sec => app.TickTime.createWithSeconds(sec) : null;
  if (!TT) return { count: null, tried: [] };

  const candidates = rangeEditCandidates(sequence, report);
  const tried = [];

  for (const method of candidates) {
    try {
      let count = 0;
      await project.lockedAccess(() => {
        project.executeTransaction((compound) => {
          // Back-to-front so earlier timecodes stay valid as later ranges collapse.
          for (let i = cuts.length - 1; i >= 0; i--) {
            const c = cuts[i];
            const action = sequence[method](TT(c.startSec), TT(c.endSec));
            if (action) { compound.addAction(action); count++; }
          }
        }, `ClipCutter: ripple-delete via ${method}`);
      });
      if (count > 0) return { count, method };
      tried.push(method + " (returned no action)");
    } catch (e) {
      tried.push(method + " (" + (e && e.message ? e.message.slice(0, 60) : "threw") + ")");
    }
  }
  return { count: null, tried };
}

// ── Format tab: current sequence readout + capability-checked resize ─
function highlightCurrentFormat(w, h) {
  const cards = $$("#fmt-list .fmt");
  cards.forEach(c => {
    c.classList.remove("is-current");
    const m = c.querySelector(".fmt-current");
    if (m) m.remove();
  });
  const match = cards.find(c => +c.dataset.w === w && +c.dataset.h === h);
  if (match) {
    match.classList.add("is-current", "active");
    cards.forEach(c => { if (c !== match) c.classList.remove("active"); });
    const cur = document.createElement("span");
    cur.className = "fmt-current";
    cur.textContent = "● Current sequence";
    match.querySelector(".fmt-body").appendChild(cur);
  }
}

async function refreshFormatInfo() {
  const info = await getSequenceInfo();
  const sequence = info.sequence;

  // Sequence frame size (accurate even after a resize; works offline).
  let w = null, h = null;
  try {
    const rect = await sequence.getFrameSize();
    if (rect) { w = Math.round(rect.width); h = Math.round(rect.height); }
  } catch (_) {}

  // fps is nice-to-have; pull it from the media probe if the helper is up.
  let fps = null;
  try {
    const r = await fetch(`${HELPER}/probe`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_path: info.mediaPath })
    });
    if (r.ok) {
      const p = await r.json();
      fps = p.fps;
      if (w == null) { w = p.width; h = p.height; }   // fallback to media dims
    }
  } catch (_) {}

  if (w != null) {
    $("#cur-seq-info").textContent = `${w} × ${h}${fps ? " • " + fps.toFixed(2) + " fps" : ""}`;
    highlightCurrentFormat(w, h);
  }
}

async function applyFormat() {
  const f = selectedFormat();
  if (!f) throw new Error("Pick a size first.");

  const project     = await ppro.Project.getActiveProject();
  const srcSequence = await project.getActiveSequence();
  if (!srcSequence) throw new Error("No active sequence.");

  let targetSeq = srcSequence;

  // "Resize a copy" — clone first (via createCloneAction, confirmed to exist
  // on this build) so the original sequence is left untouched.
  if (isOn("sw-resize-copy")) {
    if (typeof srcSequence.createCloneAction !== "function") {
      throw new Error('This build can\'t duplicate the sequence — turn off "Resize a copy" to resize in place.');
    }
    const before = new Set((await project.getSequences()).map(s => s.guid));
    await project.lockedAccess(() => {
      project.executeTransaction((compound) => {
        compound.addAction(srcSequence.createCloneAction());
      }, "ClipCutter: duplicate sequence");
    });
    const after = await project.getSequences();
    targetSeq = after.find(s => !before.has(s.guid)) || after[after.length - 1];
  }

  const settings = await targetSeq.getSettings();
  if (!settings || typeof settings.getVideoFrameRect !== "function" || typeof settings.setVideoFrameRect !== "function") {
    throw new Error("Sequence settings on this build don't expose a video frame rect getter/setter.");
  }

  const rect = await settings.getVideoFrameRect();
  rect.width  = f.w;
  rect.height = f.h;
  const applied = await settings.setVideoFrameRect(rect);
  if (!applied) throw new Error("Premiere rejected the new frame size.");

  if (typeof targetSeq.createSetSettingsAction !== "function") {
    throw new Error("createSetSettingsAction missing on this build.");
  }
  await project.lockedAccess(() => {
    project.executeTransaction((compound) => {
      compound.addAction(targetSeq.createSetSettingsAction(settings));
    }, "ClipCutter: resize sequence");
  });

  const verify = await targetSeq.getFrameSize().catch(() => null);
  const resultLabel = verify ? `${verify.width} × ${verify.height}` : `${f.w} × ${f.h}`;
  toast(`Resized "${targetSeq.name}" to ${resultLabel}.`);
  await refreshFormatInfo().catch(() => {});
}

// Add a Premiere timeline marker at each detected cut (feature-detected:
// no-op with a note if this build has no marker API — never guesses blindly).
// This build has no sequence.getMarkers(); markers come off the Markers CLASS
// (like SequenceEditor.getEditor) or the sequence's project item. Try each.
async function resolveMarkersObj(sequence) {
  const M = ppro.Markers;
  let seqPI = null; try { seqPI = await sequence.getProjectItem(); } catch (_) {}
  const tries = [];
  if (typeof sequence.getMarkers === "function") tries.push(() => sequence.getMarkers());
  if (M && typeof M.getMarkers === "function") tries.push(() => M.getMarkers(sequence));
  if (seqPI && typeof seqPI.getMarkers === "function") tries.push(() => seqPI.getMarkers());
  if (M && seqPI && typeof M.getMarkers === "function") tries.push(() => M.getMarkers(seqPI));
  for (const t of tries) { try { const m = await t(); if (m) return m; } catch (_) {} }
  return null;
}

let lastMarkerError = "";   // surfaced by diagnostics when markers fail
async function addTimelineMarkers(cuts) {
  lastMarkerError = "";
  try {
    const project  = await ppro.Project.getActiveProject();
    const sequence = project && await project.getActiveSequence();
    if (!sequence) { lastMarkerError = "no active sequence"; return 0; }
    if (!ppro.TickTime || typeof ppro.TickTime.createWithSeconds !== "function") { lastMarkerError = "TickTime.createWithSeconds missing"; return 0; }

    const markers = await resolveMarkersObj(sequence);
    if (!markers) { lastMarkerError = "could not resolve a Markers object (tried sequence + Markers class + projectItem)"; return 0; }
    const mkTT = (s) => ppro.TickTime.createWithSeconds(s);
    // Marker type — prefer the build's enum, fall back to the string "Comment".
    const MT = (ppro.Constants && ppro.Constants.MarkerType) || {};
    const cType = MT.COMMENT ?? MT.Comment ?? MT.Chapter ?? Object.values(MT)[0] ?? "Comment";

    // createAddMarkerAction(name, type, startTime, duration, comment) — plus a few
    // fallbacks in case type/duration ordering differs. Errors are collected so a
    // rescan shows exactly which signature is off.
    const errs = [];
    const attempts = [
      (c) => markers.createAddMarkerAction(c.label || "cut", cType, mkTT(c.startSec), mkTT(0), c.label || ""),
      (c) => markers.createAddMarkerAction(c.label || "cut", "Comment", mkTT(c.startSec), mkTT(0), ""),
      (c) => markers.createAddMarkerAction(c.label || "cut", cType, mkTT(c.startSec), 0, ""),
      (c) => markers.createAddMarkerAction(c.label || "cut", mkTT(c.startSec), mkTT(0), cType, ""),
      (c) => markers.createAddMarkerAction(mkTT(c.startSec), c.label || "cut", cType, mkTT(0), ""),
    ];

    let count = 0, chosen = -1;
    await project.lockedAccess(() => {
      project.executeTransaction((compound) => {
        for (const c of cuts) {
          for (let i = 0; i < attempts.length; i++) {
            if (chosen !== -1 && chosen !== i) continue;   // stick with the shape that worked
            try {
              const a = attempts[i](c);
              if (a) { compound.addAction(a); count++; chosen = i; break; }
            } catch (e) { if (chosen === -1) errs[i] = (e && e.message ? e.message : String(e)); }
          }
        }
      }, "ClipCutter: add markers");
    });
    if (!count) lastMarkerError = "all signatures failed → " + errs.map((m, i) => `[${i}] ${m}`).filter(Boolean).join(" | ");
    return count;
  } catch (e) {
    lastMarkerError = e && e.message ? e.message : String(e);
    return 0;
  }
}

// ── Action buttons ─────────────────────────────────────────────────
$$("[data-analyze]").forEach(b => b.addEventListener("click", () => {
  const kind = b.dataset.analyze;
  withBusy(b, "Working…", async () => {
    await runAnalyze(kind);
    // "Add timeline markers" is a FILLER-tab option — only mark on the filler
    // pass, never on Master/Silence/Repeats (those shouldn't drop markers).
    if (kind === "filler" && isOn("sw-markers") && allCuts.length) {
      const m = await addTimelineMarkers(allCuts);
      if (m) toast(`Added ${m} timeline marker${m === 1 ? "" : "s"}.`);
    }
    if (kind === "silence") {
      updateSilenceStats();
      toast(`Found ${allCuts.length} silence${allCuts.length === 1 ? "" : "s"}.`);
    } else if (kind === "filler") {
      if (isOn("sw-autocut-filler")) await applyCuts("filler");
      else openReview("filler");
    } else if (kind === "repeats") {
      if (!isOn("sw-review-repeats")) await applyCuts("repeats");
      else openReview("repeats");
    } else if (kind === "master") {
      if (!isOn("m-review")) await applyCuts("master");
      else openReview("master");
    }
  });
}));

$$("[data-preview]").forEach(b => b.addEventListener("click", () => {
  withBusy(b, "Analyzing…", async () => {
    await runAnalyze("silence");
    updateSilenceStats();
    openReview("silence");
  });
}));

$$("[data-apply]").forEach(b => b.addEventListener("click", () => {
  const kind = b.dataset.apply;
  withBusy(b, kind === "format" ? "Applying…" : "Building…", async () => {
    if (kind === "format") { await applyFormat(); return; }
    await applyCuts(kind);
  });
}));

$$("[data-refresh]").forEach(b => b.addEventListener("click", () =>
  withBusy(b, "Refreshing…", async () => {
    await refreshFormatInfo();
    toast("Sequence info refreshed.");
  })
));

// ── AI Flow (reorder / b-roll / pacing) ──────────────────────────
let flowPlan = null, flowSegs = null;

// The post-cleanup transcript = words NOT inside any enabled cut.
function keptWords() {
  const cuts = allCuts.filter(c => c.enabled);
  return allWords.filter(w => !cuts.some(c => w.start >= c.startSec && w.start < c.endSec));
}
const segById = (id) => (flowSegs || []).find(s => s.id === id);

async function planFlow() {
  const words = keptWords();
  if (!words.length) throw new Error("No transcript yet — run Master (or an analysis) first.");
  const status = $("#flow-status");
  status.className = "ai-status";
  status.classList.remove("hidden");
  status.textContent = "Grouping by topic and arranging the story… a long clip can take a minute.";
  $("#flow-result").classList.add("hidden");

  let resp;
  try {
    resp = await fetch(`${HELPER}/plan_flow`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words })
    });
  } catch (e) { throw new Error("Helper not reachable — is the server running?"); }
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    status.className = "ai-status err";
    status.textContent = e.detail || "AI Flow failed — check the local model in Settings.";
    return;
  }
  const data = await resp.json();
  if (!data.plan) { status.textContent = data.message || "Not enough distinct segments to reorder."; return; }
  flowPlan = data.plan; flowSegs = data.segments;
  status.classList.add("hidden");
  renderFlowPlan(data);
}

function renderFlowPlan(data) {
  const plan = data.plan, segs = data.segments;
  const box = $("#flow-result");
  const origOrder = segs.map(s => s.id);
  const P = [];

  if (plan.hook && plan.hook.segment_id) {
    const h = segById(plan.hook.segment_id);
    P.push(`<div class="flow-sec-title">Hook</div>`);
    P.push(`<div class="flow-item hook"><b>Opens on:</b> “${escapeHtml(h ? h.text : "")}”<br>${escapeHtml(plan.hook.why || "")}</div>`);
  }

  // Story = topics in order, each with its segments. A segment is "moved" if its
  // new position differs from the original recording order.
  P.push(`<div class="flow-sec-title">Story ${plan.reordered ? "· regrouped" : "· unchanged"}</div>`);
  let pos = 0;
  for (const t of (plan.topics || [])) {
    P.push(`<div class="flow-topic"><span class="flow-topic-title">${escapeHtml(t.title || "Topic")}</span>` +
           (t.why ? `<span class="flow-topic-why">${escapeHtml(t.why)}</span>` : "") + `</div>`);
    for (const id of (t.segment_ids || [])) {
      const s = segById(id); if (!s) continue;
      const moved = origOrder[pos] !== id;
      P.push(
        `<div class="flow-seg${moved ? " moved" : ""}">` +
        `<span class="idx">${pos + 1}</span>` +
        `<span class="txt">${escapeHtml(s.text)}</span>` +
        (moved ? `<span class="movedtag">was #${id}</span>` : "") +
        `</div>`);
      pos++;
    }
  }

  if (plan.broll && plan.broll.length) {
    P.push(`<div class="flow-sec-title">B-roll (${plan.broll.length})</div>`);
    for (const b of plan.broll) P.push(`<div class="flow-item">🎬 <b>${escapeHtml(b.idea || "")}</b><br>${escapeHtml(b.why || "")}</div>`);
  }
  if (plan.pacing && plan.pacing.length) {
    P.push(`<div class="flow-sec-title">Pacing</div>`);
    for (const p of plan.pacing) P.push(`<div class="flow-item"><b>${p.action === "pause" ? "Add pause" : "Tighten"} ${p.seconds || 0}s</b> — ${escapeHtml(p.why || "")}</div>`);
  }
  if (plan.warnings && plan.warnings.length) {
    P.push(`<div class="flow-sec-title">Continuity warnings</div>`);
    for (const w of plan.warnings) P.push(`<div class="flow-item warn">⚠ ${escapeHtml(w)}</div>`);
  }
  if (plan.notes) P.push(`<div class="flow-item">${escapeHtml(plan.notes)}</div>`);

  P.push(`<div class="action-bar" style="margin-top:14px;">
    <div class="btn secondary" id="flow-markers" role="button" tabindex="0">Add b-roll markers</div>
    <span class="flex-spacer"></span>
    <div class="btn primary" id="flow-apply" role="button" tabindex="0">Apply reorder</div>
  </div>`);
  if (plan.reordered) {
    P.push(`<p class="hint-note" style="margin-top:2px;">“Apply reorder” rebuilds the timeline in this order from your source media. Review the warnings above first — <b>Cmd+Z undoes it</b>.</p>`);
  } else {
    P.push(`<p class="hint-note" style="margin-top:2px;">The model kept the original order, so “Apply reorder” would change nothing.</p>`);
  }

  box.innerHTML = P.join("");
  box.classList.remove("hidden");

  const mk = $("#flow-markers");
  if (mk) mk.addEventListener("click", () => withBusy(mk, "Marking…", applyBrollMarkers));
  const ap = $("#flow-apply");
  if (ap) ap.addEventListener("click", () => withBusy(ap, "Reassembling…", applyReorder));
}

// Where each segment ENDS on the reassembled timeline. Mirrors the assemble
// engine: kept spans (segment minus enabled cuts) laid end-to-end in topic
// order. So b-roll markers land at the right spot on the REORDERED timeline.
function assemblyEndById() {
  const cuts = allCuts.filter(c => c.enabled).slice().sort((a, b) => a.startSec - b.startSec);
  const keptLen = (s, e) => {
    let len = 0, cur = s;
    for (const c of cuts) {
      if (c.endSec <= s || c.startSec >= e) continue;
      if (c.startSec > cur) len += Math.min(c.startSec, e) - cur;
      cur = Math.max(cur, c.endSec);
    }
    if (cur < e) len += e - cur;
    return len;
  };
  const endById = {};
  let pos = 0;
  for (const id of (flowPlan && flowPlan.order) || []) {
    const s = flowSegs.find(x => x.id === id);
    if (!s) continue;
    pos += keptLen(s.start, s.end);
    endById[id] = pos;               // timeline seconds at this segment's end
  }
  return endById;
}

async function applyBrollMarkers() {
  const broll = (flowPlan && flowPlan.broll) || [];
  if (!broll.length) { toast("No b-roll suggestions to mark."); return; }
  const endById = assemblyEndById();
  const marks = broll.map(b => {
    const at = endById[b.after_segment];
    return (at != null) ? { startSec: at, type: "broll", label: "B-roll: " + (b.idea || "") } : null;
  }).filter(Boolean);
  const n = await addTimelineMarkers(marks);
  toast(n ? `Added ${n} b-roll marker${n === 1 ? "" : "s"}.` : "Markers aren't supported on this build.");
}

const flowBtn = $("#flow-plan");
if (flowBtn) flowBtn.addEventListener("click", () => withBusy(flowBtn, "Planning…", planFlow));

// ── AI Edit: keyframe engine (emphasis scale zoom) ───────────────
// ADBE Motion, Scale = param index 1 (probed). We keyframe it. The exact
// add-keyframe call shape is the last unknown, so we try several shapes and
// record which worked / the errors, with phase tracking.
const MOTION_SCALE_INDEX = 1;

async function getSelectedVideoClip(sequence) {
  const CLIP = ppro.Constants?.TrackItemType?.Clip ?? 1;
  let vCount = 1; try { vCount = await sequence.getVideoTrackCount(); } catch (_) {}
  for (let vt = 0; vt < vCount; vt++) {
    const trk = await sequence.getVideoTrack(vt).catch(() => null);
    if (!trk) continue;
    for (const it of (await trk.getTrackItems(CLIP, false) || [])) {
      let sel = false; try { sel = await it.getIsSelected(); } catch (_) {}
      if (sel) return it;
    }
  }
  return null;
}

async function getScaleParam(clip) {
  const chain = await clip.getComponentChain();
  const n = await chain.getComponentCount();
  for (let i = 0; i < n; i++) {
    const c = await chain.getComponentAtIndex(i);
    const mn = typeof c.getMatchName === "function" ? await c.getMatchName() : "";
    if (/ADBE Motion/i.test(mn)) return await c.getParam(MOTION_SCALE_INDEX);
  }
  return null;
}

// Add one Scale keyframe (value at TickTime) trying several API shapes.
// Returns the shape index that worked, or -1; pushes errors into `errs`.
function addScaleKeyframeAction(compound, param, tt, value, errs) {
  const shapes = [
    // A: createKeyframe(value) → set time on it → createAddKeyframeAction(kf)
    () => { const kf = param.createKeyframe(value); if (!kf) return null;
            try { kf.position = tt; } catch (_) {} try { kf.time = tt; } catch (_) {}
            return param.createAddKeyframeAction(kf); },
    // B: createAddKeyframeAction(time, value)
    () => param.createAddKeyframeAction(tt, value),
    // C: createKeyframe(time, value) → add
    () => { const kf = param.createKeyframe(tt, value); return kf ? param.createAddKeyframeAction(kf) : null; },
    // D: setValue at time (auto-keyframes when time-varying)
    () => param.createSetValueAction(value, tt),
    // E: createSetValueAction(keyframeObj)
    () => { const kf = param.createKeyframe(value); if (!kf) return null; try { kf.position = tt; } catch (_) {} return param.createSetValueAction(kf); },
  ];
  for (let i = 0; i < shapes.length; i++) {
    try { const a = shapes[i](); if (a) { compound.addAction(a); return i; } }
    catch (e) { errs[i] = (e && e.message ? e.message : String(e)); }
  }
  return -1;
}

let lastZoomError = "";
async function emphasisZoom(clip, atSec, opts = {}) {
  const peak = opts.peak ?? 110, ramp = opts.ramp ?? 0.25, hold = opts.hold ?? 0.4;
  const app = ppro, P = { v: "start" };
  lastZoomError = "";
  try {
    const project = await app.Project.getActiveProject();
    const mkTT = (s) => app.TickTime.createWithSeconds(s);
    P.v = "get scale param";
    const scale = await getScaleParam(clip);
    if (!scale) return { ok: false, error: "no Scale param on clip" };

    P.v = "enable time-varying";
    await project.lockedAccess(() => {
      project.executeTransaction((c) => { c.addAction(scale.createSetTimeVaryingAction(true)); }, "AI Edit: enable Scale keyframes");
    });

    const kfs = [[atSec - ramp, 100], [atSec, peak], [atSec + hold, peak], [atSec + hold + ramp, 100]];
    const errs = []; let usedShape = -1;
    P.v = "add keyframes";
    await project.lockedAccess(() => {
      project.executeTransaction((c) => {
        for (const [t, v] of kfs) {
          const s = addScaleKeyframeAction(c, scale, mkTT(Math.max(0, t)), v, errs);
          if (s >= 0) usedShape = s;
        }
      }, "AI Edit: scale punch-in");
    });
    if (usedShape < 0) { lastZoomError = "no keyframe shape worked → " + errs.map((m, i) => `[${i}] ${m}`).filter(Boolean).join(" | "); return { ok: false, error: lastZoomError }; }
    return { ok: true, shape: usedShape };
  } catch (e) {
    lastZoomError = `phase=${P.v} :: ${e && e.message ? e.message : e}`;
    return { ok: false, error: lastZoomError };
  }
}

const editTestBtn = $("#edit-test-zoom");
if (editTestBtn) editTestBtn.addEventListener("click", () => withBusy(editTestBtn, "Testing…", async () => {
  const st = $("#edit-status"); st.className = "ai-status"; st.classList.remove("hidden");
  st.textContent = "Adding a test punch-in…";
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence) { st.className = "ai-status err"; st.textContent = "No active sequence."; return; }
  const clip = await getSelectedVideoClip(sequence);
  if (!clip) { st.className = "ai-status err"; st.textContent = "Select a video clip on the timeline first."; return; }
  let si = 0, cd = 0;
  try { const p = await clip.getInPoint(); si = p ? p.seconds : 0; } catch (_) {}   // SOURCE-time base
  try { const d = await clip.getDuration(); cd = d ? d.seconds : 0; } catch (_) {}
  // slow push across the whole clip so it's obvious, in source time
  const kf = [[si + 0.05, 100], [si + Math.max(0.2, cd - 0.05), 112]];
  const r = await applyScaleKeyframes(clip, kf);
  if (r.ok && !r.skipped) {
    const lo = si - 0.1, hi = si + cd + 0.1;
    const inRange = (r.placed || []).filter(t => t >= lo && t <= hi).length;
    st.className = inRange >= 2 ? "ai-status" : "ai-status err";
    st.textContent = (inRange >= 2 ? "✅ " : "⚠️ ") + `Push added. Clip source ${si.toFixed(2)}–${(si + cd).toFixed(2)}s, keyframes at [${(r.placed || []).join(", ")}] — ${inRange}/${(r.placed || []).length} inside the clip.`;
  } else { st.className = "ai-status err"; st.textContent = "Keyframe failed → " + (r.error || "unknown"); }
}));

// Generic scale-keyframe writer (used by AI Edit moves). kfList: [[timelineSec, scale%]].
async function applyScaleKeyframes(clip, kfList) {
  if (!kfList.length) return { ok: true, skipped: true };
  const project = await ppro.Project.getActiveProject();
  const mkTT = (s) => ppro.TickTime.createWithSeconds(s);
  const scale = await getScaleParam(clip);
  if (!scale) return { ok: false, error: "no Scale param" };
  await project.lockedAccess(() => {
    project.executeTransaction((c) => { c.addAction(scale.createSetTimeVaryingAction(true)); }, "AI Edit: enable Scale keyframes");
  });
  const errs = []; let used = -1;
  await project.lockedAccess(() => {
    project.executeTransaction((c) => {
      for (const [t, v] of kfList) { const s = addScaleKeyframeAction(c, scale, mkTT(Math.max(0, t)), v, errs); if (s >= 0) used = s; }
    }, "AI Edit: keyframes");
  });
  if (used < 0) return { ok: false, error: "kf failed → " + errs.map((m, i) => `[${i}] ${m}`).filter(Boolean).join(" | ") };
  // Read back the keyframes so the caller can VERIFY they landed where intended.
  let placed = [];
  try {
    const list = await scale.getKeyframeListAsTickTimes();
    placed = (list || []).map(t => (t && t.seconds != null) ? +t.seconds.toFixed(2) : t);
  } catch (_) {}
  return { ok: true, shape: used, wanted: kfList.map(k => +k[0].toFixed(2)), placed };
}

// A move → concrete keyframes on the clip's timeline range [cs, cs+cd].
function moveKeyframes(cs, cd, m) {
  const end = cs + cd, from = m.from ?? 100, to = m.to ?? 100;
  const ramp = Math.min(0.25, cd * 0.25), hold = Math.min(0.4, cd * 0.35);
  const at = cs + cd * (m.at_frac ?? 0.3);
  switch (m.move) {
    case "slow_push":
    case "ease_out":   return [[cs + 0.05, from], [end - 0.05, to]];
    case "hold_close": return [[cs + 0.02, 100], [cs + Math.min(0.5, cd * 0.4), to]];   // ease in & hold
    case "punch_in":   return [[at - ramp, from], [at, to], [at + hold, to], [at + hold + ramp, from]];
    default:           return [];   // static → no motion
  }
}

// Enumerate timeline video clips (L→R) as "shots" with their spoken text.
async function gatherShots(sequence) {
  const CLIP = ppro.Constants?.TrackItemType?.Clip ?? 1;
  let vCount = 1; try { vCount = await sequence.getVideoTrackCount(); } catch (_) {}
  const clips = [];
  for (let vt = 0; vt < vCount; vt++) {
    const trk = await sequence.getVideoTrack(vt).catch(() => null);
    if (!trk) continue;
    for (const it of (await trk.getTrackItems(CLIP, false) || [])) {
      let st = 0, du = 0, si = 0;
      try { const s = await it.getStartTime(); st = s ? s.seconds : 0; } catch (_) {}
      try { const d = await it.getDuration();  du = d ? d.seconds : 0; } catch (_) {}
      try { const p = await it.getInPoint();   si = p ? p.seconds : 0; } catch (_) {}
      clips.push({ it, start: st, dur: du, srcIn: si });
    }
  }
  clips.sort((a, b) => a.start - b.start);
  return clips.map((c, idx) => {
    const words = allWords.filter(w => w.start >= c.srcIn - 0.05 && w.start < c.srcIn + c.dur + 0.05);
    const text = words.map(w => w.word).join(" ").trim();
    // _srcIn is the base for keyframes — clip-effect keyframes live in SOURCE
    // (media) time, not sequence time.
    return { i: idx, seconds: +c.dur.toFixed(2), text, _clip: c.it, _start: c.start, _dur: c.dur, _srcIn: c.srcIn };
  });
}

let editShots = null, editPlan = null;
const MOVE_LABEL = { static: "Static", slow_push: "Slow push-in", punch_in: "Punch-in", hold_close: "Hold close", ease_out: "Ease out" };

async function planEdit() {
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence — open your timeline.");
  const shots = await gatherShots(sequence);
  if (!shots.length) throw new Error("No clips on the timeline.");
  editShots = shots;
  const st = $("#edit-status"); st.className = "ai-status"; st.classList.remove("hidden");
  st.textContent = "Planning the cinematography… a moment.";
  $("#edit-result").classList.add("hidden");

  let resp;
  try {
    resp = await fetch(`${HELPER}/plan_edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shots: shots.map(s => ({ i: s.i, seconds: s.seconds, text: s.text })) })
    });
  } catch (e) { throw new Error("Helper not reachable — is the server running?"); }
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); st.className = "ai-status err"; st.textContent = e.detail || "AI Edit failed — check the local model in Settings."; return; }
  editPlan = await resp.json();
  st.classList.add("hidden");
  renderEditPlan();
}

function renderEditPlan() {
  const box = $("#edit-result");
  const shotById = {}; for (const s of editShots) shotById[s.i] = s;
  const moves = (editPlan.shots || []);
  const active = moves.filter(m => m.move !== "static").length;
  const P = [`<div class="flow-sec-title">Camera moves · ${active} of ${moves.length} shots</div>`];
  for (const m of moves) {
    const s = shotById[m.i]; if (!s) continue;
    const isStatic = m.move === "static";
    const range = isStatic ? "100%" : `${m.from}→${m.to}%`;
    P.push(
      `<div class="flow-seg${isStatic ? "" : " moved"}">` +
      `<span class="idx">${m.i + 1}</span>` +
      `<span class="txt"><b>${MOVE_LABEL[m.move] || m.move}</b> · ${range}` +
      (m.why ? `<br><span style="color:var(--text-dim);font-size:11.5px;">${escapeHtml(m.why)}</span>` : "") +
      `<br><span style="color:var(--text-mute);font-size:11px;">“${escapeHtml((s.text || "").slice(0, 90))}”</span></span>` +
      `</div>`);
  }
  if (editPlan.notes) P.push(`<div class="flow-item">${escapeHtml(editPlan.notes)}</div>`);
  P.push(`<div class="action-bar" style="margin-top:14px;"><span class="flex-spacer"></span><div class="btn primary" id="edit-apply" role="button" tabindex="0">Apply moves</div></div>`);
  box.innerHTML = P.join("");
  box.classList.remove("hidden");
  const ap = $("#edit-apply");
  if (ap) ap.addEventListener("click", () => withBusy(ap, "Applying…", applyEditPlan));
}

async function applyEditPlan() {
  if (!editPlan || !editShots) throw new Error("Plan first.");
  overlayShow("Adding camera moves");
  const moves = editPlan.shots || [];
  const withMotion = moves.filter(m => m.move !== "static");
  let done = 0, applied = 0, failed = "", verify = null;
  for (const m of withMotion) {
    const s = editShots.find(x => x.i === m.i); if (!s) continue;
    // keyframes in SOURCE time: base at the clip's in-point, span [srcIn, srcIn+dur]
    const kf = moveKeyframes(s._srcIn, s._dur, m);
    const r = await applyScaleKeyframes(s._clip, kf);
    if (r.ok && !r.skipped) {
      applied++;
      // verify against the FIRST applied shot: keyframes must sit inside the clip
      if (!verify) {
        const lo = s._srcIn - 0.1, hi = s._srcIn + s._dur + 0.1;
        const inRange = (r.placed || []).filter(t => t >= lo && t <= hi).length;
        verify = { i: m.i, srcIn: +s._srcIn.toFixed(2), dur: +s._dur.toFixed(2), placed: r.placed, inRange, total: (r.placed || []).length };
      }
    } else if (!r.ok && !failed) failed = r.error;
    done++;
    overlayProgress(6 + done / (withMotion.length || 1) * 94, `Shot ${done} of ${withMotion.length}`, `${done}/${withMotion.length}`);
    await sleep(120);
  }
  overlayHide();

  // Surface the read-back verification in the status area so we KNOW it worked.
  const st = $("#edit-status"); st.classList.remove("hidden");
  if (applied && verify) {
    const ok = verify.inRange >= 2;
    st.className = ok ? "ai-status" : "ai-status err";
    st.textContent = (ok ? "✅ " : "⚠️ ") +
      `Applied ${applied} move${applied === 1 ? "" : "s"}. Shot ${verify.i + 1}: clip source ${verify.srcIn}–${(verify.srcIn + verify.dur).toFixed(2)}s, keyframes at [${(verify.placed || []).join(", ")}] — ${verify.inRange}/${verify.total} inside the clip.` +
      (ok ? "" : " Keyframes landed OUTSIDE the clip range — wrong time base.");
  } else {
    st.className = "ai-status err";
    st.textContent = "No moves applied" + (failed ? " — " + failed : ".");
  }
  if (applied) toast(`Added ${applied} camera move${applied === 1 ? "" : "s"}. (Cmd+Z to undo.)`);
}

const editPlanBtn = $("#edit-plan");
if (editPlanBtn) editPlanBtn.addEventListener("click", () => withBusy(editPlanBtn, "Planning…", planEdit));

// ── Helper status (Settings view) ────────────────────────────────
async function checkHelper() {
  const pill = $("#helper-pill"), hint = $("#helper-hint");
  if (!pill) return;
  try {
    const r = await fetch(`${HELPER}/health`, { method: "GET" });
    if (r.ok) {
      const info = await r.json().catch(() => ({}));
      pill.className = "status-pill ok";
      pill.innerHTML = `<span class="dot"></span>${info.whisper ? "Ready" : "No transcription"}`;
      if (hint) hint.textContent = info.ffmpeg ? "connected" : "ffmpeg missing";
      return;
    }
  } catch (_) {}
  pill.className = "status-pill bad";
  pill.innerHTML = `<span class="dot"></span>Offline`;
  if (hint) hint.textContent = "run python server.py";
}
setInterval(checkHelper, 5000);
checkHelper();

// ── One-time capability scan (dev diagnostic, silent) ─────────────
// Unfiltered live method dump of the timeline-editing objects, POSTed to the
// helper so real split/remove/ripple capability can be confirmed from outside
// Premiere — a narrow keyword filter missed real methods once already
// (createSetSettingsAction wasn't caught until re-scanned broadly).
function listAllMethods(obj) {
  const names = new Set();
  let p = obj;
  while (p && p !== Object.prototype && p != null) {
    for (const n of Object.getOwnPropertyNames(p)) {
      try { if (typeof obj[n] === "function") names.add(n); } catch (_) {}
    }
    p = Object.getPrototypeOf(p);
  }
  return [...names].sort();
}

let lastEditReport = null;

// Deep-probe the effects/keyframe API: walk a clip's component chain → the
// Motion component → its params (Scale/Position) → their keyframe methods.
async function probeMotion(items) {
  const statics = (c) => c ? Object.getOwnPropertyNames(c).filter(n => { try { return typeof c[n] === "function"; } catch (_) { return false; } }).sort() : [];
  const dump = (c) => ({ statics: statics(c), proto: c ? listAllMethods(c) : [] });
  const M = { classes: {
    VideoComponentChain: dump(ppro.VideoComponentChain),
    Component:           dump(ppro.Component),
    ComponentFactory:    dump(ppro.ComponentFactory),
    VideoFilterFactory:  dump(ppro.VideoFilterFactory),
    VideoFilterComponent:dump(ppro.VideoFilterComponent),
    Keyframe:            dump(ppro.Keyframe),
    PointKeyframe:       dump(ppro.PointKeyframe),
    Properties:          dump(ppro.Properties),
  }};
  try {
    let item = null;
    for (const it of items) { try { if (await it.getIsSelected()) { item = it; break; } } catch (_) {} }
    if (!item) item = items[0];
    M.clip = item ? await item.getName().catch(() => "?") : "(no clip)";
    const chain = item && typeof item.getComponentChain === "function" ? await item.getComponentChain() : null;
    M.chainMethods = chain ? listAllMethods(chain) : ["(no chain)"];

    let count = 0;
    const countName = ["getComponentCount", "getCount", "getComponentsCount"].find(n => chain && typeof chain[n] === "function");
    if (countName) { try { count = await chain[countName](); } catch (_) {} }
    M.componentCount = count; M.countName = countName || "(none)";
    const getName = ["getComponentAtIndex", "getComponent", "getComponentAt"].find(n => chain && typeof chain[n] === "function");
    M.componentGetter = getName || "(none)";

    M.components = [];
    if (chain && getName) {
      for (let i = 0; i < Math.min(count || 6, 8); i++) {
        try {
          const comp = await chain[getName](i);
          if (!comp) continue;
          const mn = typeof comp.getMatchName === "function" ? await comp.getMatchName().catch(() => "") : "";
          const nm = typeof comp.getName === "function" ? await comp.getName().catch(() => "") : "";
          const info = { index: i, matchName: mn, name: nm, methods: listAllMethods(comp) };
          let pc = 0;
          const pcName = ["getParamCount", "getParameterCount", "getPropertyCount"].find(n => typeof comp[n] === "function");
          if (pcName) { try { pc = await comp[pcName](); } catch (_) {} }
          info.paramCount = pc; info.paramCountName = pcName || "(none)";
          const pGet = ["getParam", "getParamAtIndex", "getParameter", "getProperty"].find(n => typeof comp[n] === "function");
          info.paramGetter = pGet || "(none)";
          if (pGet) {
            info.params = [];
            for (let p = 0; p < Math.min(pc || 10, 16); p++) {
              try {
                const prm = await comp[pGet](p);
                if (!prm) continue;
                let kf = "?"; try { kf = await prm.areKeyframesSupported(); } catch (_) {}
                const vinfo = {};
                try {
                  const v = await prm.getStartValue();
                  vinfo.jsType = typeof v;
                  if (v && typeof v === "object") {
                    vinfo.ownProps = Object.getOwnPropertyNames(v);
                    vinfo.methods = listAllMethods(v);
                    // try common value accessors
                    try { vinfo.dotValue = JSON.stringify(v.value); } catch (_) {}
                    for (const g of ["getValue", "get", "value"]) {
                      try { if (typeof v[g] === "function") { vinfo["call_" + g] = JSON.stringify(await v[g]()); } } catch (_) {}
                    }
                  } else {
                    vinfo.scalar = v;
                  }
                } catch (e) { vinfo.err = e && e.message ? e.message : String(e); }
                info.params.push({ index: p, keyframable: kf, value: vinfo });
              } catch (_) {}
            }
          }
          M.components.push(info);
        } catch (_) {}
      }
    }
  } catch (e) { M.error = e && e.message ? e.message : String(e); }
  return M;
}

async function buildEditReport() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence — open your timeline.");

  const CLIP = ppro.Constants?.TrackItemType?.Clip ?? 1;
  const vTrack = await sequence.getVideoTrack(0);
  const items  = vTrack ? await vTrack.getTrackItems(CLIP, false) : [];
  const aTrack = sequence.getAudioTrack ? await sequence.getAudioTrack(0).catch(() => null) : null;

  // Probe the marker API (which shape does this build expose?)
  const statics = (cls) => cls ? Object.getOwnPropertyNames(cls).filter(n => { try { return typeof cls[n] === "function"; } catch (_) { return false; } }).sort() : [];
  let markersObj = null;
  try { markersObj = await resolveMarkersObj(sequence); } catch (_) {}
  const markerClassStatics  = statics(ppro.Marker);
  const markersClassStatics = statics(ppro.Markers);
  const markerClass = ppro.Marker ? listAllMethods(ppro.Marker) : [];

  const report = {
    host: (() => { try { const h = require("uxp").host; return `${h?.name} ${h?.version}`; } catch (_) { return "?"; } })(),
    pproClasses: Object.getOwnPropertyNames(ppro).sort(),
    project:    listAllMethods(project),
    sequence:   listAllMethods(sequence),
    videoTrack: vTrack ? listAllMethods(vTrack) : [],
    audioTrack: aTrack ? listAllMethods(aTrack) : [],
    trackItem:  items[0] ? listAllMethods(items[0]) : [],
    trackItemCount: items.length,
    markersObj: markersObj ? listAllMethods(markersObj) : ["(could not resolve Markers object)"],
    markerClassStatics,
    markersClassStatics,
    markerClassProto: markerClass,
    markerTypeEnum: (() => { try { return ppro.Constants && ppro.Constants.MarkerType ? JSON.parse(JSON.stringify(ppro.Constants.MarkerType)) : "(no Constants.MarkerType)"; } catch (_) { return "(unreadable)"; } })(),
    lastMarkerError: lastMarkerError || "(none — try Add b-roll markers first)",
    motion: await probeMotion(items)
  };
  lastEditReport = report;
  return report;
}

// Methods across sequence/track/item that could perform an in-place edit
function findEditPrimitives(report) {
  const RX = /razor|split|ripple|delete|remove|lift|extract|insert|overwrite|trim|cut|edit|clear/i;
  const grab = (arr, src) => (arr || []).filter(n => RX.test(n)).map(n => `${src}.${n}`);
  return [
    ...grab(report.sequence, "sequence"),
    ...grab(report.videoTrack, "videoTrack"),
    ...grab(report.trackItem, "trackItem"),
    ...grab(report.project, "project")
  ];
}

function renderDiagnostics(report) {
  const out = $("#diag-out");
  if (!out) return;
  const primitives = findEditPrimitives(report);
  const fmt = (label, arr) => `── ${label} (${arr.length}) ──\n${arr.join(", ") || "(none)"}\n`;
  const markerNames = [...(report.markersObj || []), ...(report.markerClassStatics || []), ...(report.markerClassProto || [])]
    .filter(n => /marker/i.test(n) || /add|create/i.test(n));
  out.textContent =
    `host: ${report.host}\nclips on V1: ${report.trackItemCount}\n\n` +
    `★ IN-PLACE EDIT CANDIDATES (${primitives.length}):\n${primitives.join("\n") || "(none found)"}\n\n` +
    `★ MARKER API — last error: ${report.lastMarkerError}\n` +
    `MarkerType enum: ${JSON.stringify(report.markerTypeEnum)}\n` +
    fmt("resolved Markers object methods", report.markersObj) +
    fmt("ppro.Markers statics", report.markersClassStatics) +
    fmt("ppro.Marker statics", report.markerClassStatics) +
    fmt("ppro.Marker proto", report.markerClassProto) +
    `\n` +
    fmt("ppro classes", report.pproClasses) +
    fmt("sequence", report.sequence) +
    fmt("videoTrack", report.videoTrack) +
    fmt("audioTrack", report.audioTrack) +
    fmt("trackItem", report.trackItem) +
    fmt("project", report.project);
}

async function runDiagnostics() {
  const report = await buildEditReport();
  renderDiagnostics(report);
  // UXP blocks copy-paste from the panel, so also write the report to disk via
  // the helper (helper/clipcutter_debug.json) for out-of-band inspection.
  try {
    await fetch(`${HELPER}/debug_log`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report)
    });
  } catch (_) {}
  return report;
}

const diagBtn = $("#diag-run");
if (diagBtn) diagBtn.addEventListener("click", () => withBusy(diagBtn, "Scanning…", runDiagnostics));
