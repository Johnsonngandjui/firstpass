/* ═══════════════════════════════════════════════════════════════
   FirstPass — UI controller + Premiere/helper wiring

   Flow: read the active sequence's clips (ppro) → POST /analyze on the
   local helper, once per distinct source file → poll /status → review
   (word transcript for filler/repeats/master, a cut-list for silence)
   → apply the cut to the ACTIVE sequence in place via SequenceEditor
   (overwrite-split + remove, see rebuildInPlace).

   Note: earlier builds round-tripped through /build_xml + importFiles()
   to produce a NEW sequence, because the razor/ripple API wasn't
   exposed. Premiere 26 exposes it, so we edit in place and rely on
   Cmd+Z. The helper's /build_xml endpoint is a leftover from that era
   and is no longer called from here.
   ═══════════════════════════════════════════════════════════════ */

const { entrypoints } = require("uxp");
const ppro = require("premierepro");
const HELPER = "http://localhost:7742";
const PROBE_INSERT = false;  // probe done: insert needs the RAW ProjectItem, not the cast ClipProjectItem

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Build marker — bump when you change the panel so a reload is easy to confirm.
// After reloading in UDT, this line appears in the UDT debug console.
const BUILD = "flow-14b+progress-overlay · 2026-08-20";
console.log("FirstPass panel loaded — build:", BUILD);

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
// Clicking a size IS the action — it selects and applies in one step (there
// is no separate Apply button). Mirrors withBusy's re-entry guard and error
// toast; applyFormat toasts its own success and refreshes the readout.
let fmtApplying = false;
$$("#fmt-list .fmt").forEach(card => card.addEventListener("click", async () => {
  if (fmtApplying) return;
  $$("#fmt-list .fmt").forEach(c => c.classList.remove("active"));
  card.classList.add("active");
  fmtApplying = true;
  card.classList.add("is-busy");
  try {
    await applyFormat();
  } catch (err) {
    toast(err && err.message ? err.message : String(err), true);
  } finally {
    fmtApplying = false;
    card.classList.remove("is-busy");
  }
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

// Gather the source ranges of EVERY target clip (scope), tagged with its media,
// across every distinct source file. Cached so review counts stay synchronous.
let clipMetas = [];
async function gatherClipMetas() {
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
        try { const p = await it.getInPoint();  si = p ? p.seconds : 0; } catch (_) {}
        try { const d = await it.getDuration(); du = d ? d.seconds : 0; } catch (_) {}
        clipMetas.push({ si, du, media: itMp });
      }
    }
  } catch (_) {}
}

// Distinct source files across the scope's target clips (each gets its own pass).
async function gatherTargetMedia() {
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence) return [];
  const CLIP = ppro.Constants?.TrackItemType?.Clip ?? 1;
  const selMode = scopeValue() === "selected";
  let vCount = 1; try { vCount = await sequence.getVideoTrackCount(); } catch (_) {}
  const set = new Set();
  for (let vt = 0; vt < vCount; vt++) {
    const trk = await sequence.getVideoTrack(vt).catch(() => null);
    if (!trk) continue;
    for (const it of (await trk.getTrackItems(CLIP, false) || [])) {
      let include = !selMode;
      if (selMode) { try { include = await it.getIsSelected(); } catch (_) { include = false; } }
      if (!include) continue;
      try {
        const rc = ppro.ClipProjectItem.cast(await it.getProjectItem());
        const mp = rc ? await rc.getMediaFilePath() : null;
        if (mp) { set.add(mp); if (!lastMediaItems.has(mp)) lastMediaItems.set(mp, rc); }
      } catch (_) {}
    }
  }
  return [...set];
}

// ── Pre-rendered source audio (fast path for Analyze) ─────────────────────
// Premiere renders each source's audio to a 16 kHz mono WAV — the exact format
// transcription wants (its own WAV_Mono_16bit_16kHz preset) — so the helper can
// skip ffmpeg-decoding the full video. Measured ~35x realtime via the Settings
// probe. Every failure path just returns less, and the helper falls back to its
// own extraction, so this can only make Analyze faster, never break it.
let lastMediaItems = new Map();   // media path → ClipProjectItem, filled by gatherTargetMedia

const WAV_PRESETS = [
  "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Settings/EncoderPresets/WAV_Mono_16bit_16kHz.epr",
  "/Applications/Adobe Premiere Pro (Beta)/Adobe Premiere Pro (Beta).app/Contents/Settings/EncoderPresets/WAV_Mono_16bit_16kHz.epr",
];

function mediaPathHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function probeWavInfo(p) {
  try {
    const r = await fetch(`${HELPER}/probe`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_path: p })
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j) return null;
    return { duration: j.duration || 0, size: j.size_bytes || 0 };
  } catch (_) { return null; }
}

// Do NOT use EncoderManager.encodeProjectItem here: despite the name it hands
// the job to Adobe Media Encoder's queue (its startQueueImmediately param is
// the tell), which cold-starts AME and is slower than just extracting with
// ffmpeg. Only exportSequence with ExportType.IMMEDIATELY renders in-app —
// so each source gets a throwaway sequence built around it, exported, removed.
// The temp sequence contains the full media from zero, so sequence time equals
// source time and every downstream timestamp is untouched.
async function prerenderSourceAudio(mediaPaths, onStatus, dbg) {
  const say = dbg || (() => {});
  const out = {};
  let project = null, mgr = null, userSeq = null;
  try {
    project = await ppro.Project.getActiveProject();
    userSeq = project ? await project.getActiveSequence() : null;
    mgr = await ppro.EncoderManager.getManager();
  } catch (e) { say(`setup threw: ${String((e && e.message) || e)}`); }
  if (!project || !mgr) { say(`no ${project ? "EncoderManager" : "project"} — aborting`); return out; }
  const exportType = ppro.Constants?.ExportType?.IMMEDIATELY;
  say(`exportType = ${JSON.stringify(exportType)}`);

  for (let i = 0; i < mediaPaths.length; i++) {
    const mp = mediaPaths[i];
    const rc = lastMediaItems.get(mp);
    if (!rc) { say(`no ClipProjectItem for ${mp.split("/").pop()} — skipping`); continue; }
    if (onStatus) onStatus(i + 1, mediaPaths.length);

    const tag = `${mediaPathHash(mp)}_${Date.now()}`;
    const tmpName = `FirstPass temp audio ${tag}`;
    const wav = `/tmp/firstpass_src_${tag}.wav`;

    // createSequenceFromMedia honors the source item's in/out marks — and
    // FirstPass's own apply pass sets marks while editing, so a leftover range
    // renders a seconds-long WAV of a minutes-long source. (Found the hard
    // way: a 1.57s render whose transcript was a single "um".) Read the marks,
    // clear them for the render, put them back after. If they can't be read,
    // don't clear them — the duration check below discards a partial render.
    let savedIn = null, savedOut = null, clearedMarks = false;
    try {
      const MT_ANY = ppro.Constants?.MediaType?.ANY;
      savedIn  = await rc.getInPoint(MT_ANY);
      savedOut = await rc.getOutPoint(MT_ANY);
    } catch (_) {}
    if (savedIn && savedOut) {
      try {
        await project.lockedAccess(() => {
          project.executeTransaction((c) => {
            c.addAction(rc.createClearInOutPointsAction());
          }, "FirstPass: clear source marks for audio render");
        });
        clearedMarks = true;
      } catch (e) { say(`could not clear in/out marks: ${String((e && e.message) || e)}`); }
    } else {
      say("could not read in/out marks — rendering as-is");
    }

    let made = false;
    try {
      let tmpSeq = null;
      try {
        tmpSeq = await project.createSequenceFromMedia(tmpName, [rc]);
      } catch (e) { say(`createSequenceFromMedia threw: ${String((e && e.message) || e)}`); }
      if (!tmpSeq) { say(`no temp sequence for ${mp.split("/").pop()}`); continue; }
      made = true;
      say(`temp sequence created for ${mp.split("/").pop()}`);

      let ok = false;
      for (const preset of WAV_PRESETS) {
        try { await mgr.exportSequence(tmpSeq, exportType, wav, preset, true); ok = true; break; }
        catch (e) { say(`exportSequence (${preset.split("/")[2]}) threw: ${String((e && e.message) || e)}`); }
      }
      say(ok ? "export call accepted — waiting for the WAV" : "every export attempt failed");

      // A WAV is done when BOTH its duration and its byte size hold steady
      // across polls. Duration alone lies: Premiere can write the final header
      // first and stream samples after it, so a growing file already reports
      // its finished length — that is exactly the truncation trap.
      if (ok) {
        const deadline = Date.now() + 120000;
        let lastD = -1, lastS = -1, finalD = 0;
        while (Date.now() < deadline) {
          const info = await probeWavInfo(wav);
          if (info && info.duration > 0 && info.size > 44 &&
              info.duration === lastD && info.size === lastS) {
            say(`WAV finalized: ${info.duration}s, ${info.size} bytes`);
            finalD = info.duration;
            break;
          }
          lastD = info ? info.duration : -1;
          lastS = info ? info.size : -1;
          await new Promise((res) => setTimeout(res, 500));
        }
        if (!finalD) {
          say(`timed out waiting for the WAV (last: ${lastD}s, ${lastS} bytes)`);
        } else {
          // The bug class this whole check exists for: a render that
          // "succeeds" but covers a fraction of the source. Only a WAV within
          // 2% of the source's own duration leaves here; the helper re-checks.
          const srcInfo = await probeWavInfo(mp);
          const srcDur = (srcInfo && srcInfo.duration) || 0;
          if (srcDur && Math.abs(finalD - srcDur) <= 0.02 * srcDur) {
            say(`duration matches source (${srcDur}s) — accepted`);
            out[mp] = wav;
          } else {
            say(`WAV is ${finalD}s but the source is ${srcDur}s — discarded`);
          }
        }
      }
    } catch (_) {
    } finally {
      // Remove the throwaway sequence again. If any of this fails the only
      // cost is a clearly named sequence left in the project's root bin.
      if (made) {
        try {
          const root = await project.getRootItem();
          const folder = ppro.FolderItem.cast(root);
          const items = folder ? await folder.getItems() : [];
          for (const it of items) {
            let nm = null;
            try { nm = typeof it.getName === "function" ? await it.getName() : it.name; } catch (_) {}
            if (nm !== tmpName) continue;
            await project.lockedAccess(() => {
              project.executeTransaction((c) => {
                c.addAction(folder.createRemoveItemAction(it));
              }, "FirstPass: remove temp audio sequence");
            });
            break;
          }
        } catch (_) {}
      }
      // Whatever happened above, hand back the in/out marks we borrowed.
      if (clearedMarks) {
        try {
          await project.lockedAccess(() => {
            project.executeTransaction((c) => {
              c.addAction(rc.createSetInOutPointsAction(savedIn, savedOut));
            }, "FirstPass: restore source marks");
          });
        } catch (e) { say(`could not restore in/out marks: ${String((e && e.message) || e)}`); }
      }
    }
  }

  // Give the user back the sequence they were looking at.
  try { if (userSeq) await project.setActiveSequence(userSeq); } catch (_) {}
  return out;
}

// Real on-timeline totals for a set of cuts: for each target clip, count only
// the cuts of ITS media inside ITS source range (clips can be trimmed
// differently). Synchronous — uses the cached clip metas.
function multiClipTotals(cuts) {
  if (!clipMetas.length) {
    return { count: cuts.length, clips: 1,
      removableSec: cuts.reduce((s, c) => s + (c.endSec - c.startSec), 0) };
  }
  let count = 0, removable = 0;
  for (const m of clipMetas) {
    for (const c of cuts) {
      if (c._media && m.media && c._media !== m.media) continue;   // cut belongs to another source file
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
async function startAndPoll(params, onProgress) {
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
    if (onProgress) onProgress(status.progress || 0, status.message || "Working…");
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

let mediaDurations = {};   // media path → duration (multi-clip sequences)
async function runAnalyze(kind) {
  // Show the overlay IMMEDIATELY on click — before the (sometimes slow) sequence
  // and clip scan — so you never sit on a bare "Working…" button with no feedback.
  const overlayTitle = { master: "Cleaning every clip", filler: "Finding filler words",
    repeats: "Finding repeated takes", silence: "Finding dead air" }[kind] || "Analyzing";
  overlayShow(overlayTitle);
  const t0 = Date.now();
  const elapsed = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} elapsed`;
  };
  overlayProgress(1, "Reading your sequence…", elapsed());

  try {
    const info = await getSequenceInfo();   // validates project/sequence + selection
    const medias = await gatherTargetMedia();
    if (!medias.length) throw new Error("No clips found for this scope.");

    const padBefore = parseFloat($("#pad-before")?.value ?? "0.1") || 0;
    const padAfter  = parseFloat($("#pad-after")?.value ?? "0.1") || 0;
    const paddingMs = Math.round(((padBefore + padAfter) / 2) * 1000);

    const wantsFiller  = kind === "filler"  || (kind === "master" && isOn("m-filler"));
    const wantsRepeats = kind === "repeats" || (kind === "master" && isOn("m-repeats"));
    // "Smart dead-air" needs a transcript for speech-gap detection.
    const wantsSilence = kind === "silence" || (kind === "master" && isOn("m-silence"));
    const smart        = isOn("sw-smart-silence");
    const wantsWords   = wantsFiller || wantsRepeats || (wantsSilence && smart);

    allCuts = []; allWords = []; mediaDurations = {};
    currentKind = kind;
    let primaryStatus = null;

    // Measured, not assumed: ffmpeg pulls the audio track out of a 78s clip in
    // 0.03s — extraction was never the slow step (model load + inference are).
    // So Analyze does NOT prerender audio through Premiere: that dance costs a
    // visible temp-sequence flash and undo entries and saves ~nothing locally.
    // prerenderSourceAudio and the Settings probe stay — they are the
    // foundation for a hosted mode that uploads audio instead of footage.
    const audioPaths = {};

    overlayProgress(2, `Preparing ${medias.length} clip${medias.length === 1 ? "" : "s"}…`, elapsed());

    // Analyze EACH distinct source file and tag its cuts, so every clip — not
    // just the first — gets cleaned. (Different clips = different media = need
    // their own transcription/analysis.)
    for (let mi = 0; mi < medias.length; mi++) {
      const M = medias[mi];
      // Overall bar = this clip's slice of the whole run, filled by the live job
      // progress inside it. So one clip still gets a moving 0→100 status bar.
      const base = 2 + (mi / medias.length) * 96;
      const span = 96 / medias.length;
      const label = medias.length > 1 ? ` · clip ${mi + 1}/${medias.length}` : "";
      overlayProgress(base, `Analyzing${label}…`, elapsed());
      const onJob = (pct, msg) =>
        overlayProgress(base + (pct / 100) * span, `${msg}${label}`, elapsed());
      const params = {
        media_paths:    [M],
        audio_paths:    audioPaths,
        seq_name:       info.seqName,
        silence_db:     parseFloat($("#sil-thresh").value),
        silence_dur:    parseFloat($("#sil-dur").value),
        padding_ms:     paddingMs,
        detect_silence: wantsSilence,
        remove_fillers: wantsFiller,
        detect_takes:   wantsRepeats,
        transcribe:     wantsWords,
        similarity:     sensSimilarity(),
        fillers:        wantsFiller ? selectedFillers() : null,
        keep_last:      isOn("sw-keep-last"),
        smart_silence:  smart,
        auto_threshold: smart
      };
      const status = await startAndPoll(params, onJob);
      // prefix ids with the media index so they stay unique across clips
      const cuts = filterByKind(kind, status.cuts || []).map(c => ({ ...c, _media: M, id: mi + ":" + c.id }));
      allCuts.push(...cuts);
      allWords.push(...(status.words || []).map(w => ({ ...w, _media: M })));   // keep EVERY clip's words
      mediaDurations[M] = status.duration;
      if (!primaryStatus) primaryStatus = status;
    }

    overlayProgress(99, "Mapping clips to the timeline…", elapsed());
    mediaPath = medias[0];
    mediaDuration = mediaDurations[medias[0]] ?? mediaDuration;
    lastAnalysis = primaryStatus;   // loudness/method readout reflects the first clip
    await gatherClipMetas();         // ALL target clips, tagged with media
    await saveFlowState();           // transcript survives a panel/Premiere restart
  } finally {
    overlayHide();
  }
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
// The review transcript shows the FIRST clip only (multiple clips' words can't
// share one coherent view); the CUTS still apply to every clip.
function reviewWords() {
  const pm = allWords[0]?._media;
  return allWords.filter(w => !pm || !w._media || w._media === pm);
}

function buildWordClassMap(words) {
  const primaryMedia = words[0]?._media;
  const cuts = allCuts
    .filter(c => (c.type === "filler" || c.type === "repeated_take") && (!primaryMedia || !c._media || c._media === primaryMedia))
    .slice().sort((a, b) => a.startSec - b.startSec);

  const idxToCut = new Array(words.length).fill(null);
  let ci = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    while (ci < cuts.length && cuts[ci].endSec <= w.start) ci++;
    if (ci < cuts.length && w.start >= cuts[ci].startSec && w.start < cuts[ci].endSec) {
      idxToCut[i] = cuts[ci];
    }
  }

  // Decorative "kept take" highlight: right after an enabled repeated_take
  // cut, mark the next same-length run of un-cut words as the retained take.
  const decorative = new Set();
  const seen = new Set();
  for (let i = 0; i < words.length; i++) {
    const cut = idxToCut[i];
    if (!cut || cut.type !== "repeated_take" || !cut.enabled || seen.has(cut.id)) continue;
    seen.add(cut.id);
    let j = i;
    while (j < words.length && idxToCut[j] === cut) j++;
    const len = j - i;
    let k = j, count = 0;
    while (k < words.length && count < len) {
      if (!idxToCut[k]) { decorative.add(k); count++; }
      k++;
    }
  }
  return { idxToCut, decorative };
}

function renderWordTranscript() {
  const box = $("#transcript");
  box.classList.toggle("no-highlight", !isOn("sw-highlight"));   // "Highlight in transcript" toggle
  const words = reviewWords();
  if (!words.length) {
    box.innerHTML = '<p style="color:var(--text-mute);">No transcript available — run Analyze first.</p>';
    return;
  }
  const { idxToCut, decorative } = buildWordClassMap(words);
  // Only wrap HIGHLIGHTED words in a <span>; leave untouched words as plain text.
  // A 10-min clip has ~2000 words — a span each makes the scroll container crawl
  // in UXP. Plain text collapses the untouched runs into cheap text nodes.
  const parts = words.map((w, i) => {
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
        // cuts are matched to each clip by media below — so include EVERY target
        // clip here, not just clips of one source file.
        if (!srcC || typeof srcC.createSetInOutPointsAction !== "function") continue;

        let cs = 0, ci = 0, cd = 0;
        try { const s = await it.getStartTime(); cs = s ? s.seconds : 0; } catch (_) {}
        try { const p = await it.getInPoint();   ci = p ? p.seconds : 0; } catch (_) {}
        try { const d = await it.getDuration();  cd = d ? d.seconds : 0; } catch (_) {}
        clipsMeta.push({ vIndex: vt, clipStart: cs, clipSourceIn: ci, clipDur: cd, rawItem: rawIt, srcClip: srcC, media: mp });
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
    // a cut only applies to a clip of its OWN media, and only if it fits inside.
    const sameMedia = (cu, m) => !cu._media || !m.media || cu._media === m.media;
    const fitsClip = (cu, m) => sameMedia(cu, m) &&
      cu.startSec >= m.clipSourceIn - 0.05 && cu.endSec <= m.clipSourceIn + m.clipDur + 0.05;
    const overlapsClip = (cu, m) => sameMedia(cu, m) &&
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
          }, "FirstPass: in/out");
        });
        P.v = `split(ts=${ts.toFixed(2)},v=${vIndex})`;
        await project.lockedAccess(() => {
          project.executeTransaction((c) => {
            c.addAction(editor.createOverwriteItemAction(rawItem, mkTT(ts), vIndex, vIndex));
          }, "FirstPass: split silence");
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
            }, "FirstPass: ripple-delete silence");
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
                                 "FirstPass: backup sequence");
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
    // Never hand a NaN / negative / Infinite second-value to the native engine —
    // an out-of-range TickTime is a prime candidate for a hard Premiere crash.
    const mkTT = (s) => {
      const v = Number(s);
      if (!isFinite(v) || v < 0) throw new Error(`invalid time ${s}`);
      return app.TickTime.createWithSeconds(Math.round(v * 1000) / 1000);
    };
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

    // Build a map media → { rawItem (RAW ProjectItem for overwrite), srcClip } so
    // each segment can be placed from ITS OWN source file. Also the timeline extent.
    P.v = "find sources";
    const srcByMedia = {};
    let origEnd = 0;
    for (let vt = 0; vt < vCount; vt++) {
      const trk = await sequence.getVideoTrack(vt).catch(() => null);
      if (!trk) continue;
      for (const it of (await trk.getTrackItems(CLIP, false) || [])) {
        let st = 0, du = 0;
        try { const s = await it.getStartTime(); st = s ? s.seconds : 0; } catch (_) {}
        try { const d = await it.getDuration();  du = d ? d.seconds : 0; } catch (_) {}
        origEnd = Math.max(origEnd, st + du);
        let ri = null, sc = null, mp = null;
        try { ri = await it.getProjectItem(); } catch (_) {}
        sc = ri ? app.ClipProjectItem.cast(ri) : null;
        try { mp = sc ? await sc.getMediaFilePath() : null; } catch (_) {}
        if (mp && !srcByMedia[mp] && sc && typeof sc.createSetInOutPointsAction === "function") srcByMedia[mp] = { rawItem: ri, srcClip: sc };
      }
    }
    if (!Object.keys(srcByMedia).length) return { ok: false, missing: ["source clip(s) of the segments"] };

    // ── Lay each segment (new order) from its own source, on V1, running pos ──
    // Contiguous placement: each segment starts exactly where the previous ended,
    // so the insertion point is always ≤ the timeline's current end and overwrite
    // extends cleanly (starting a placement in the VOID past the end is what throws
    // "Invalid"/destabilises Premiere — we structurally never do that). `extent`
    // tracks the growing end so we can HARD-GUARD against ever placing past it.
    P.v = "assemble";
    const total = orderedSegs.length || 1;
    // pre-filter to valid, non-trivial segments so counts + guards are honest
    const segs = orderedSegs.filter(s =>
      s && isFinite(s.start) && isFinite(s.end) && s.start >= 0 && (s.end - s.start) > 0.03);
    const requested = segs.length;
    let pos = 0, n = 0, extent = origEnd, skipped = 0;
    const srcKeys = Object.keys(srcByMedia);
    for (const seg of segs) {
      const inS = seg.start, outS = seg.end, len = outS - inS;
      // Require the segment's OWN source. Only fall back when there's a single
      // source on the timeline (so the fallback is unambiguously correct). Placing
      // a segment's in/out against the WRONG media can point past that media's end
      // — an out-of-range source range is a prime hard-crash trigger.
      const src = srcByMedia[seg.media] || (srcKeys.length === 1 ? srcByMedia[srcKeys[0]] : null);
      if (!src || !src.rawItem || !src.srcClip) { skipped++; continue; }
      // Guard: the start must be within the current extent (+small tolerance).
      // With contiguous placement pos==extent, so this only trips if a prior
      // overwrite unexpectedly did NOT extend — in which case we STOP rather than
      // fire an out-of-range overwrite that could crash Premiere.
      if (pos > extent + 0.25) { skipped += (requested - n); break; }
      try {
        P.v = `setInOut(${inS.toFixed(2)},${outS.toFixed(2)})`;
        await project.lockedAccess(() => {
          project.executeTransaction((c) => {
            c.addAction(src.srcClip.createSetInOutPointsAction(mkTT(inS), mkTT(outS)));
          }, "FirstPass: segment in/out");
        });
        P.v = `overwrite@${pos.toFixed(2)}`;
        await project.lockedAccess(() => {
          project.executeTransaction((c) => {
            c.addAction(editor.createOverwriteItemAction(src.rawItem, mkTT(pos), 0, 0));
          }, "FirstPass: place segment");
        });
        pos += len; extent = Math.max(extent, pos); n++;
        step(6 + (n / total) * 80, `Placing segment ${n} of ${total}`, `${n} / ${total}`);
        await sleep(160);
      } catch (segErr) {
        // Isolate a single bad segment: skip it and keep going rather than aborting
        // (and definitely rather than crashing). The tail trim still cleans up.
        skipped++;
        await sleep(120);
      }
    }
    const assemblyLen = pos;

    // ── Trim the leftover tail (old content beyond the new assembly) ──────────
    // Wrapped so a stale-ref / bad-selection failure here can't crash or abort:
    // the reassembly is already done; a failed trim just leaves harmless tail
    // content the user can delete (and Cmd+Z still reverts everything).
    if (n > 0 && origEnd > assemblyLen + 0.05) {
      P.v = `trim-tail@${assemblyLen.toFixed(2)}`;
      const findTail = async (track) => {
        const out = [];
        for (const it of (track ? await track.getTrackItems(CLIP, false) : []) || []) {
          let st = -1; try { const x = await it.getStartTime(); st = x ? x.seconds : -1; } catch (_) {}
          if (st >= assemblyLen - 0.02) out.push(it);
        }
        return out;
      };
      try {
        await project.lockedAccess(async () => {
          const tail = [];
          for (let vt = 0; vt < vCount; vt++) tail.push(...await findTail(await sequence.getVideoTrack(vt).catch(() => null)));
          for (let at = 0; at < aCount; at++) tail.push(...await findTail(await sequence.getAudioTrack(at).catch(() => null)));
          if (!tail.length) return;
          let sel = null;
          TIS.createEmptySelection((x) => { sel = x; });
          if (!sel) return;
          for (const it of tail) { try { sel.addItem(it, true); } catch (_) {} }
          project.executeTransaction((c) => {
            const a = editor.createRemoveItemsAction(sel, true, MT, false);
            if (a) c.addAction(a);
          }, "FirstPass: trim tail");
        });
      } catch (_) { /* leave the tail rather than risk a crash */ }
    }

    step(100, "Done", "");
    await sleep(180);
    return { ok: true, placed: n, requested, skipped: Math.max(0, requested - n), seconds: assemblyLen };
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
  // its KEPT spans — the ranges left after subtracting the enabled cuts OF ITS
  // OWN media — and tag each span with which source file it comes from.
  const enabled = allCuts.filter(c => c.enabled);
  const keptWithin = (s, e, media) => {
    const cuts = enabled.filter(c => !c._media || !media || c._media === media).sort((a, b) => a.startSec - b.startSec);
    const spans = []; let cur = s;
    for (const c of cuts) {
      if (c.endSec <= s || c.startSec >= e) continue;
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
    const M = s._media;
    // Clamp the source range to the media's known duration so an out-of-range
    // in/out can never reach Premiere's engine (a hard-crash trigger). Leave a
    // 50ms margin off the end to stay safely inside the media.
    const dur = (mediaDurations && mediaDurations[M]) ? mediaDurations[M] - 0.05 : Infinity;
    const clamp = (t) => Math.max(0, Math.min(t, dur));
    const a = clamp(s._srcStart != null ? s._srcStart : s.start);
    const b = clamp(s._srcEnd != null ? s._srcEnd : s.end);
    if (b - a <= 0.03) continue;
    for (const sp of keptWithin(a, b, M)) {
      const cs = clamp(sp.start), ce = clamp(sp.end);
      if (ce - cs > 0.03) orderedSegs.push({ start: cs, end: ce, media: M });
    }
  }
  if (!orderedSegs.length) throw new Error("Nothing to assemble — your arrangement is saved; try Arrange again.");

  const app = ppro;
  const project = await app.Project.getActiveProject();
  if (!project) throw new Error("No active project open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence — open your timeline.");

  overlayShow("Reassembling your story");
  overlayProgress(4, "Reading the new order…", "");

  // Flag the apply as in-flight BEFORE touching the timeline. If Premiere crashes
  // mid-assemble, this flag survives on disk and the next launch shows a recovery
  // hint (undo the partial edit, re-apply) with the arrangement intact.
  await saveFlowState({ applying: true });

  let result;
  try {
    result = await assembleReorder(app, project, sequence, orderedSegs,
      (pct, sub, count) => overlayProgress(pct, sub, count));
  } catch (err) {
    overlayHide();
    await saveFlowState({ applying: false });   // finished (with error) — not a crash
    throw new Error((err && err.message) ? err.message : String(err));
  }
  overlayHide();

  if (result.ok) {
    if (!result.placed) {
      await saveFlowState({ applying: false });   // keep plan for retry
      throw new Error("Couldn't place any segments — the timeline is unchanged. Your arrangement is saved; try again.");
    }
    await clearFlowState();                        // applied cleanly — no stale restore next launch
    const extra = (result.placed < result.requested)
      ? ` · ${result.requested - result.placed} skipped` : "";
    toast(`Reassembled in the new order · ${result.placed} segments${extra}. (Cmd+Z to undo.)`);
    return;
  }
  await saveFlowState({ applying: false });   // primitives missing — nothing was touched
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
        }, `FirstPass: ripple-delete via ${method}`);
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
      }, "FirstPass: duplicate sequence");
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
    }, "FirstPass: resize sequence");
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
      }, "FirstPass: add markers");
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
let flowPlan = null, flowSegs = null, flowGlobal = null;

// Lay every clip's KEPT words on one global timeline (with a gap between clips)
// so AI Flow can reorder segments ACROSS clips, and we can map each segment back
// to its own source file.
function buildGlobalTimeline() {
  const kept = keptWords();
  const order = [];
  for (const m of clipMetas) if (m.media && !order.includes(m.media)) order.push(m.media);
  if (!order.length) { const pm = kept[0]?._media; if (pm) order.push(pm); }
  const offsets = {}, gWords = [];
  const GAP = 3;   // seconds between clips → guarantees a segment break at each seam
  let off = 0;
  for (const M of order) {
    const mw = kept.filter(w => (w._media || order[0]) === M).sort((a, b) => a.start - b.start);
    if (!mw.length) continue;
    offsets[M] = off;
    for (const w of mw) gWords.push({ word: w.word, start: +(w.start + off).toFixed(3), end: +(w.end + off).toFixed(3), _media: M });
    off += mw[mw.length - 1].end + GAP;
  }
  return { gWords, offsets, order };
}
function mediaAtGlobal(gStart, offsets, order) {
  let best = order[0], bestOff = -1;
  for (const M of order) { if (offsets[M] != null && offsets[M] <= gStart + 0.001 && offsets[M] > bestOff) { best = M; bestOff = offsets[M]; } }
  return best;
}

// The post-cleanup transcript = words NOT inside any enabled cut (of their own media).
function keptWords() {
  const cuts = allCuts.filter(c => c.enabled);
  return allWords.filter(w => !cuts.some(c =>
    (!c._media || !w._media || c._media === w._media) && w.start >= c.startSec && w.start < c.endSec));
}
const segById = (id) => (flowSegs || []).find(s => s.id === id);

// Flow and Camera work from Master's transcript, but they shouldn't strand
// someone who came straight here. Transcription touches nothing on the
// timeline, so when there's no transcript yet we simply make one and carry on
// — a transcribe-only analyze per source: no cuts detected, nothing applied.
async function ensureTranscript(onMsg) {
  const info = await getSequenceInfo();
  const medias = await gatherTargetMedia();
  if (!medias.length) throw new Error("No clips found for this scope.");

  // Coverage is per source file, not "any words at all": a transcript restored
  // from another project would count as present while matching none of these
  // clips — and the model would plan blind again. Drop words that belong to
  // media not on this timeline, then transcribe only what's actually missing
  // (which also picks up clips added since the last Master run).
  allWords = allWords.filter(w => !w._media || medias.includes(w._media));
  const missing = medias.filter(M => !allWords.some(w => w._media === M));
  if (!missing.length) return;

  for (let mi = 0; mi < missing.length; mi++) {
    const M = missing[mi];
    const label = missing.length > 1 ? ` · clip ${mi + 1}/${missing.length}` : "";
    const status = await startAndPoll({
      media_paths:    [M],
      seq_name:       info.seqName,
      transcribe:     true,
      detect_silence: false,
      remove_fillers: false,
      detect_takes:   false,
      smart_silence:  false,
      auto_threshold: false
    }, (pct, msg) => { if (onMsg) onMsg(`No transcript yet — transcribing first${label}: ${msg}`); });
    allWords.push(...(status.words || []).map(w => ({ ...w, _media: M })));
    mediaDurations[M] = status.duration;
  }
  await gatherClipMetas();
  await saveFlowState();   // the fresh transcript survives a restart too
}

async function planFlow() {
  const status = $("#flow-status");
  status.className = "ai-status";
  status.classList.remove("hidden");
  await ensureTranscript((m) => { status.textContent = m; });
  const g = buildGlobalTimeline();
  flowGlobal = g;
  const words = g.gWords;
  if (!words.length) throw new Error("The transcript came back empty — is there speech on these clips?");
  status.textContent = "Removing repeated takes and arranging the story… a long clip can take a minute.";
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
  if (!data.plan) { status.textContent = data.message || "Not enough distinct segments to arrange."; return; }
  flowPlan = data.plan; flowSegs = data.segments;
  // map each global-time segment back to its own source file + source times
  for (const s of flowSegs) {
    const M = mediaAtGlobal(s.start, flowGlobal.offsets, flowGlobal.order);
    s._media = M;
    s._srcStart = s.start - (flowGlobal.offsets[M] || 0);
    s._srcEnd = s.end - (flowGlobal.offsets[M] || 0);
  }
  status.classList.add("hidden");
  renderFlowPlan(data);
  saveFlowState({ applying: false });   // persist so a later crash can't lose it
}

function renderFlowPlan(data) {
  const plan = data.plan, segs = data.segments;
  const box = $("#flow-result");
  const removed = plan.removed || [];      // repeated takes the coherent cut drops
  const order = plan.order || [];          // survivors, in story order
  const origOrder = order.slice().sort((a, b) => a - b);  // survivors in recorded order
  const P = [];

  // Removed repeated takes — shown first so the user sees what the cut cleaned up.
  if (removed.length) {
    P.push(`<div class="flow-sec-title">Removed repeated takes (${removed.length})</div>`);
    for (const r of removed) {
      P.push(`<div class="flow-seg dropped"><span class="txt" style="text-decoration:line-through;opacity:.6">${escapeHtml(r.text || "")}</span></div>`);
    }
  }

  if (plan.hook && plan.hook.segment_id) {
    const h = segById(plan.hook.segment_id);
    P.push(`<div class="flow-sec-title">Hook</div>`);
    P.push(`<div class="flow-item hook"><b>Opens on:</b> “${escapeHtml(h ? h.text : "")}”<br>${escapeHtml(plan.hook.why || "")}</div>`);
  }

  // Story = topics in order, each with its segments. A segment is "moved" if its
  // new position differs from the recorded order (of the survivors).
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
        (moved ? `<span class="movedtag">moved</span>` : "") +
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
    <div class="btn primary" id="flow-apply" role="button" tabindex="0">Apply cut &amp; reorder</div>
  </div>`);
  const bits = [];
  if (removed.length) bits.push("drops the repeated takes above");
  if (plan.reordered) bits.push("rebuilds the timeline in this order");
  P.push(`<p class="hint-note" style="margin-top:2px;">“Apply cut &amp; reorder” ${bits.length ? bits.join(" and ") : "reassembles the timeline"} from your source media. <b>Cmd+Z undoes it</b>.</p>`);

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
  const enabled = allCuts.filter(c => c.enabled);
  const keptLen = (s, e, media) => {
    const cuts = enabled.filter(c => !c._media || !media || c._media === media).sort((a, b) => a.startSec - b.startSec);
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
    const a = s._srcStart != null ? s._srcStart : s.start;
    const b = s._srcEnd != null ? s._srcEnd : s.end;
    pos += keptLen(a, b, s._media);
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

// Free the local Qwen models from RAM so Premiere playback stays smooth. They
// reload on the next AI Flow run (first inference just pays the load time again).
async function freeModels() {
  const st = $("#free-mem-status");
  if (st) st.textContent = "";
  let resp;
  try {
    resp = await fetch(`${HELPER}/free_models`, { method: "POST" });
  } catch (e) { throw new Error("Helper not reachable — is the server running?"); }
  if (!resp.ok) throw new Error("Couldn't free memory — check the local model in Settings.");
  const data = await resp.json();
  const stillBig = (data.still_loaded || []).length;
  if (st) st.textContent = stillBig
    ? "Some models are still loading — try again in a moment."
    : `Freed ${(data.freed || []).length} model${(data.freed || []).length === 1 ? "" : "s"} from memory.`;
  toast(stillBig ? "Models still busy — try again shortly." : "Local model freed — Premiere has its memory back.");
}
const freeMemBtn = $("#free-mem");
if (freeMemBtn) freeMemBtn.addEventListener("click", () => withBusy(freeMemBtn, "Freeing…", freeModels));

// ── AI Camera: keyframe engine (emphasis scale zoom) ─────────────
// ADBE Motion, Scale = param index 1 (probed). We keyframe it. The exact
// add-keyframe call shape is the last unknown, so we try several shapes and
// record which worked / the errors, with phase tracking.
const MOTION_SCALE_INDEX = 1;

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

// Add one Scale keyframe (value at TickTime). PROBED: createKeyframe(value) →
// set .position → createAddKeyframeAction(kf) is the shape this build honors.
function addScaleKeyframeAction(compound, param, tt, value, errs) {
  try {
    const kf = param.createKeyframe(value);
    if (!kf) { errs[0] = "createKeyframe returned null"; return -1; }
    try { kf.value = value; } catch (_) {}      // belt-and-suspenders
    try { kf.position = tt; } catch (_) {}
    try { kf.time = tt; } catch (_) {}
    const a = param.createAddKeyframeAction(kf);
    if (a) { compound.addAction(a); return 0; }
    errs[0] = "createAddKeyframeAction returned null";
  } catch (e) { errs[0] = (e && e.message ? e.message : String(e)); }
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
      project.executeTransaction((c) => { c.addAction(scale.createSetTimeVaryingAction(true)); }, "AI Camera: enable Scale keyframes");
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
      }, "AI Camera: scale punch-in");
    });
    if (usedShape < 0) { lastZoomError = "no keyframe shape worked → " + errs.map((m, i) => `[${i}] ${m}`).filter(Boolean).join(" | "); return { ok: false, error: lastZoomError }; }
    return { ok: true, shape: usedShape };
  } catch (e) {
    lastZoomError = `phase=${P.v} :: ${e && e.message ? e.message : e}`;
    return { ok: false, error: lastZoomError };
  }
}


// Generic scale-keyframe writer (used by AI Camera moves). kfList: [[timelineSec, scale%]].
async function applyScaleKeyframes(clip, kfList) {
  if (!kfList.length) return { ok: true, skipped: true };
  const project = await ppro.Project.getActiveProject();
  const mkTT = (s) => ppro.TickTime.createWithSeconds(s);
  const scale = await getScaleParam(clip);
  if (!scale) return { ok: false, error: "no Scale param" };
  // Clear any stale keyframes (repeated tests leave them, which stack/interfere):
  // toggling time-varying off then on resets the param, then we add fresh.
  await project.lockedAccess(() => {
    project.executeTransaction((c) => { try { c.addAction(scale.createSetTimeVaryingAction(false)); } catch (_) {} }, "AI Camera: clear keyframes");
  });
  await project.lockedAccess(() => {
    project.executeTransaction((c) => { c.addAction(scale.createSetTimeVaryingAction(true)); }, "AI Camera: enable keyframes");
  });
  const errs = []; let used = -1;
  await project.lockedAccess(() => {
    project.executeTransaction((c) => {
      for (const [t, v] of kfList) { const s = addScaleKeyframeAction(c, scale, mkTT(Math.max(0, t)), v, errs); if (s >= 0) used = s; }
    }, "AI Camera: keyframes");
  });
  if (used < 0) return { ok: false, error: "kf failed → " + errs.filter(Boolean).join(" | ") };
  // Read back actual VALUES at each keyframe time → proves the scale animates.
  let values = [];
  try {
    for (const [t] of kfList) { const vo = await scale.getValueAtTime(mkTT(Math.max(0, t))); values.push((vo && vo.value != null) ? +(+vo.value).toFixed(1) : "?"); }
  } catch (_) {}
  return { ok: true, wanted: kfList.map(k => k[1]), values };
}

// Enumerate timeline video clips, GROUPED into sentence "shots". Cut footage is
// many micro-clips (one per removed silence); a camera move should span the
// whole sentence, not restart on every fragment. We group consecutive clips
// until one ends a sentence (. ! ?).
async function gatherShots(sequence) {
  const CLIP = ppro.Constants?.TrackItemType?.Clip ?? 1;
  let vCount = 1; try { vCount = await sequence.getVideoTrackCount(); } catch (_) {}
  const clips = [];
  for (let vt = 0; vt < vCount; vt++) {
    const trk = await sequence.getVideoTrack(vt).catch(() => null);
    if (!trk) continue;
    for (const it of (await trk.getTrackItems(CLIP, false) || [])) {
      let st = 0, du = 0, si = 0, mp = null;
      try { const s = await it.getStartTime(); st = s ? s.seconds : 0; } catch (_) {}
      try { const d = await it.getDuration();  du = d ? d.seconds : 0; } catch (_) {}
      try { const p = await it.getInPoint();   si = p ? p.seconds : 0; } catch (_) {}
      try { const rc = ppro.ClipProjectItem.cast(await it.getProjectItem()); mp = rc ? await rc.getMediaFilePath() : null; } catch (_) {}
      // words of THIS clip's media within its source range
      const words = allWords.filter(w => (!w._media || !mp || w._media === mp) && w.start >= si - 0.05 && w.start < si + du + 0.05);
      clips.push({ it, start: st, dur: du, srcIn: si, media: mp, words });
    }
  }
  clips.sort((a, b) => a.start - b.start);

  const groups = []; let cur = [];
  for (const c of clips) {
    cur.push(c);
    const lw = c.words[c.words.length - 1];
    const endsSentence = lw && /[.!?]$/.test((lw.word || "").trim());
    if (endsSentence) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);

  return groups.map((g, idx) => {
    const text = g.flatMap(c => c.words).map(w => w.word).join(" ").trim();
    const dur = g.reduce((s, c) => s + c.dur, 0);
    return {
      i: idx, seconds: +dur.toFixed(2), text, _dur: dur,
      _clips: g.map(c => ({ it: c.it, dur: c.dur, srcIn: c.srcIn })),
    };
  });
}

// Apply a move ACROSS a shot's clips — the scale ramp is distributed over the
// whole sentence so it reads as one continuous camera move.
async function applyMoveToShot(shot, m) {
  const clips = shot._clips, D = shot._dur || clips.reduce((s, c) => s + c.dur, 0) || 1;
  const from = m.from ?? 100;
  let to = m.to ?? 100;
  // Amplify so the motion is actually FELT (the model tends conservative), then cap.
  if (m.move === "slow_push" || m.move === "ease_out") { const dir = to >= from ? 1 : -1; if (Math.abs(to - from) < 7) to = from + dir * 8; }
  else if (m.move === "punch_in") { if (to - from < 12) to = from + 14; }
  else if (m.move === "hold_close") { if (to - 100 < 7) to = 108; }
  to = Math.min(124, Math.max(96, to));
  const results = [];

  if (m.move === "slow_push" || m.move === "ease_out") {
    const val = (p) => from + (to - from) * Math.max(0, Math.min(1, p));
    let off = 0;
    for (const c of clips) {
      const kf = [[c.srcIn + 0.02, val(off / D)], [c.srcIn + Math.max(0.1, c.dur - 0.02), val((off + c.dur) / D)]];
      results.push(await applyScaleKeyframes(c.it, kf)); off += c.dur;
    }
  } else if (m.move === "hold_close") {
    for (let k = 0; k < clips.length; k++) {
      const c = clips[k];
      const kf = k === 0 ? [[c.srcIn + 0.02, 100], [c.srcIn + Math.max(0.1, c.dur - 0.02), to]]
                         : [[c.srcIn + 0.02, to], [c.srcIn + Math.max(0.1, c.dur - 0.02), to]];
      results.push(await applyScaleKeyframes(c.it, kf));
    }
  } else if (m.move === "punch_in") {
    // Quick zoom in at the emphasis point, then HOLD at the peak to the end of
    // the sentence (no snap back out — that looked wrong).
    const target = D * (m.at_frac ?? 0.25);
    let acc = 0, pcIdx = 0, pcAcc = 0;
    for (let k = 0; k < clips.length; k++) { const c = clips[k]; if (target >= acc && target < acc + c.dur) { pcIdx = k; pcAcc = acc; break; } acc += c.dur; }
    const ramp = 0.16;
    for (let k = 0; k < clips.length; k++) {
      const c = clips[k];
      if (k < pcIdx) continue;                                  // before the punch → stay at 100
      let kf;
      if (k === pcIdx) {
        const local = Math.max(0.05, Math.min(c.dur - 0.05, target - pcAcc));
        const at = c.srcIn + local;
        kf = [[c.srcIn + 0.02, from], [Math.max(c.srcIn + 0.04, at - ramp), from], [at, to], [c.srcIn + Math.max(0.1, c.dur - 0.02), to]];
      } else {
        kf = [[c.srcIn + 0.02, to], [c.srcIn + Math.max(0.1, c.dur - 0.02), to]];   // hold the punch
      }
      results.push(await applyScaleKeyframes(c.it, kf));
    }
  }
  return results;
}

let editShots = null, editPlan = null;
const MOVE_LABEL = { static: "Static", slow_push: "Slow push-in", punch_in: "Punch-in", hold_close: "Hold close", ease_out: "Ease out" };

// Return a clip to a clean, un-keyframed Scale of 100 — but only if it still
// carries keyframes (e.g. left over from a previous plan where it was moved).
async function resetClipTo100(clip, srcIn, dur) {
  const scale = await getScaleParam(clip);
  if (!scale) return false;
  let tv = false; try { tv = await scale.isTimeVarying(); } catch (_) {}
  if (!tv) return false;                                  // already clean
  await applyScaleKeyframes(clip, [[srcIn + 0.02, 100], [srcIn + Math.max(0.1, dur - 0.02), 100]]);  // flatten to 100
  const project = await ppro.Project.getActiveProject();
  await project.lockedAccess(() => {
    project.executeTransaction((c) => { try { c.addAction(scale.createSetTimeVaryingAction(false)); } catch (_) {} }, "AI Camera: static reset");
  });
  return true;
}

async function planEdit() {
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence — open your timeline.");
  const st = $("#edit-status"); st.className = "ai-status"; st.classList.remove("hidden");
  // Without a transcript the shots come back text-less and the model would
  // plan camera moves blind — so make the transcript first (touches nothing).
  await ensureTranscript((m) => { st.textContent = m; });
  const shots = await gatherShots(sequence);
  if (!shots.length) throw new Error("No clips on the timeline.");
  editShots = shots;
  st.textContent = "Planning your camera moves… a moment.";
  $("#edit-result").classList.add("hidden");

  let resp;
  try {
    resp = await fetch(`${HELPER}/plan_edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shots: shots.map(s => ({ i: s.i, seconds: s.seconds, text: s.text })) })
    });
  } catch (e) { throw new Error("Helper not reachable — is the server running?"); }
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); st.className = "ai-status err"; st.textContent = e.detail || "AI Camera failed — check the local model in Settings."; return; }
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
    // spread the move across the sentence's clips (keyframes in SOURCE time)
    const rs = (await applyMoveToShot(s, m)).filter(Boolean);
    const okOne = rs.find(r => r.ok && !r.skipped);
    if (okOne) {
      applied++;
      if (!verify) {
        // measure the WHOLE sentence's scale range across all its clips
        const allVals = rs.flatMap(r => r.values || []).filter(v => typeof v === "number");
        const lo = allVals.length ? Math.min(...allVals) : 100;
        const hi = allVals.length ? Math.max(...allVals) : 100;
        const changed = (hi - lo) > 0.5 || Math.abs(hi - 100) > 0.5;   // push (range) or hold (elevated)
        verify = { i: m.i, move: m.move, from: m.from, to: m.to, lo: +lo.toFixed(1), hi: +hi.toFixed(1), changed };
      }
    } else { const bad = rs.find(r => !r.ok); if (bad && !failed) failed = bad.error; }
    done++;
    overlayProgress(6 + done / (withMotion.length || 1) * 94, `Shot ${done} of ${withMotion.length}`, `${done}/${withMotion.length}`);
    await sleep(120);
  }
  // Reset STATIC shots that still carry keyframes from an earlier plan → clean 100.
  let cleaned = 0;
  for (const m of moves.filter(x => x.move === "static")) {
    const s = editShots.find(x => x.i === m.i); if (!s) continue;
    for (const c of s._clips) { try { if (await resetClipTo100(c.it, c.srcIn, c.dur)) cleaned++; } catch (_) {} }
  }
  overlayHide();

  // Surface the value read-back so we KNOW the scale actually animates.
  const st = $("#edit-status"); st.classList.remove("hidden");
  if (applied && verify) {
    st.className = verify.changed ? "ai-status" : "ai-status err";
    st.textContent = (verify.changed ? "✅ " : "⚠️ ") +
      `Applied ${applied} move${applied === 1 ? "" : "s"}. Shot ${verify.i + 1} (${verify.move}): plan ${verify.from}→${verify.to}%, applied scale ${verify.lo}–${verify.hi}% across the sentence.` +
      (verify.changed ? "" : " Scale didn't change — keyframe value not applied.");
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
// ── Crash-safe resume ────────────────────────────────────────────
// The arrange plan lives only in memory, so a Premiere crash during "Apply cut
// & reorder" would lose it. We mirror it to the helper (disk) after Arrange and
// flag when an apply is in-flight, so on reopen the plan is restored and — if the
// apply was interrupted — the user gets a clear recovery hint instead of a lost
// session. All best-effort: persistence failures never block the actual editing.
async function saveFlowState(patch) {
  try {
    const body = JSON.stringify({
      v: 1, kind: "flow", savedAt: Date.now(),
      plan: flowPlan, segs: flowSegs, cuts: allCuts, durs: mediaDurations,
      // The transcript is the expensive part — persisting it means AI Flow and
      // AI Camera still work after a panel or Premiere restart.
      words: allWords,
      ...(patch || {})
    });
    await fetch(`${HELPER}/save_state`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body
    });
  } catch (_) { /* offline / disk error — resume just won't be available */ }
}
async function clearFlowState() {
  try { await fetch(`${HELPER}/clear_state`, { method: "POST" }); } catch (_) {}
}

async function restoreFlowState() {
  let state = null;
  try {
    const r = await fetch(`${HELPER}/load_state`);
    if (r.ok) state = (await r.json()).state;
  } catch (_) { return; }               // helper offline — nothing to restore
  if (!state) return;

  // Phase 1: the transcript alone — restored even when no plan was saved, so
  // AI Flow / AI Camera work after a restart without re-running Master.
  if (Array.isArray(state.words) && state.words.length && !allWords.length) {
    allWords = state.words;
    if (Array.isArray(state.cuts)) allCuts = state.cuts;
    if (state.durs && typeof state.durs === "object") mediaDurations = state.durs;
  }

  // Phase 2: a saved arrangement, with its recovery UI.
  if (state.kind !== "flow" || !state.plan || !state.segs) return;

  flowPlan = state.plan;
  flowSegs = state.segs;
  if (Array.isArray(state.cuts)) allCuts = state.cuts;   // needed to rebuild kept spans on Apply
  if (state.durs && typeof state.durs === "object") mediaDurations = state.durs;

  try { showView("flow"); } catch (_) {}
  try { renderFlowPlan({ plan: flowPlan, segments: flowSegs }); } catch (_) {}

  const status = $("#flow-status");
  if (status) {
    status.classList.remove("hidden");
    if (state.applying) {
      status.className = "ai-status err";
      status.innerHTML = "⚠ Your last <b>Apply</b> was interrupted (Premiere may have closed). " +
        "If your timeline looks half-rebuilt, press <b>Cmd+Z</b> in Premiere until it's back to how it " +
        "was, then click <b>Apply cut &amp; reorder</b> again. Your arrangement below was restored.";
    } else {
      status.className = "ai-status";
      status.textContent = "Restored your last arrangement — pick up where you left off. " +
        "Click “Apply cut & reorder” when ready, or run Arrange again to redo it.";
    }
  }
}

setInterval(checkHelper, 5000);
checkHelper();
restoreFlowState();

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


// ── Diagnostics for bug reports ─────────────────────────────────────────────
// Editors report problems in plain language ("it just didn't work"), which is
// not reproducible. This collects the machine facts that actually matter —
// versions, device, whether the models are present — and deliberately nothing
// about the footage: no paths, filenames or transcript text.
let LAST_ERROR = null;
try {
  window.addEventListener("error", (e) => { LAST_ERROR = e?.message || String(e); });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e?.reason; LAST_ERROR = (r && r.message) ? r.message : String(r);
  });
} catch (_) {}

async function collectDiagnostics() {
  const probe = async (path) => {
    try {
      const r = await fetch(`${HELPER}${path}`);
      return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
    } catch (_) { return { error: "helper unreachable" }; }
  };
  const [health, ai] = await Promise.all([probe("/health"), probe("/ai_status")]);

  const host = (() => {
    try { const h = require("uxp").host; return `${h?.name} ${h?.version}`; } catch (_) { return "unknown"; }
  })();
  const platform = (() => {
    try { const os = require("os"); return `${os.platform()} ${os.release?.() || ""}`.trim(); } catch (_) { return "unknown"; }
  })();

  return [
    `FirstPass:   ${BUILD}`,
    `Premiere:    ${host}`,
    `Platform:    ${platform}`,
    `Helper:      ${health.error ? health.error : "running"}`,
    `Whisper:     ${health.error ? "?" : (health.whisper ? "installed" : "MISSING")}`,
    `ffmpeg:      ${health.error ? "?" : (health.ffmpeg ? "found" : "MISSING")}`,
    `AI runtime:  ${ai.error ? ai.error : (ai.runtime ? "running" : "NOT RUNNING")}`,
    `AI model:    ${ai.error ? "?" : (ai.model ? "ready" : "NOT PULLED")}`,
    `Last error:  ${LAST_ERROR || "(none this session)"}`
  ].join("\n");
}

const diagCopyBtn = $("#diag-copy");
if (diagCopyBtn) diagCopyBtn.addEventListener("click", () => withBusy(diagCopyBtn, "Collecting…", async () => {
  const report = await collectDiagnostics();
  const out = $("#diag-out");
  if (out) out.textContent = report;

  // UXP blocks Cmd+C out of the panel, so try the clipboard API and fall back to
  // writing the file via the helper — one of the two always gives the user
  // something they can attach to an issue.
  let copied = false;
  try {
    const { clipboard } = require("uxp");
    if (clipboard && clipboard.setContent) {
      await clipboard.setContent({ "text/plain": report });
      copied = true;
    }
  } catch (_) {}

  let saved = false;
  try {
    const r = await fetch(`${HELPER}/debug_log`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diagnostics: report })
    });
    saved = r.ok;
  } catch (_) {}

  if (copied)     toast("Diagnostics copied — paste them into your issue.");
  else if (saved) toast("Saved to helper/firstpass_debug.json — attach that file.");
  else            toast("Couldn't copy. Screenshot the text above instead.", true);
}));

