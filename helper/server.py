"""
ClipCutter helper server
Runs on localhost:7742 — UXP panel talks to this.

Dependencies (see requirements.txt):
  pip install fastapi uvicorn torch torchaudio
  pip install git+https://github.com/nyrahealth/CrisperWhisper
  ffmpeg must be on PATH
"""

import asyncio, json, os, re, shutil, subprocess, sys, tempfile, urllib.parse, uuid, wave
import xml.sax.saxutils as _sx
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional


# ── ffmpeg resolution ────────────────────────────────────────────────────────
def _resolve_ffmpeg() -> Optional[str]:
    """Prefer a real ffmpeg on PATH; otherwise fall back to the binary bundled
    with imageio-ffmpeg so the helper works without a system install."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


FFMPEG = _resolve_ffmpeg()

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="ClipCutter Helper")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Job store (in-memory, single-user tool) ────────────────────────────────
jobs: dict[str, dict] = {}


# ── Request models ──────────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    media_paths:    list[str]
    seq_name:       str
    silence_db:     float = -40.0
    silence_dur:    float = 0.5
    padding_ms:     int   = 80
    detect_silence: bool  = True   # run dead-air detection at all (off for filler/repeats-only passes)
    remove_fillers: bool  = True
    detect_takes:   bool  = True
    transcribe:     bool  = True
    similarity:     float = 0.82   # repeat-take match threshold; lower = more sensitive
    fillers:        Optional[list[str]] = None   # exact words/phrases to cut; None → built-in list
    keep_last:      bool  = True   # on a repeated take, keep the last pass (cut earlier) vs keep first
    smart_silence:  bool  = True   # dead-air = gaps between transcribed words (level-independent) when words exist
    auto_threshold: bool  = True   # audio-only path: derive the dB floor from the clip's own loudness

class ApplyRequest(BaseModel):
    cuts:       list[dict]
    padding_ms: int = 80

class ProbeRequest(BaseModel):
    media_path: str


# ── Health ─────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"ok": True, "whisper": _whisper_available(), "ffmpeg": bool(FFMPEG)}


# ── AI Flow (reorder / b-roll / pacing) — additive, isolated module ─────────
class PlanFlowRequest(BaseModel):
    words: list[dict]            # word-level transcript from the last analysis
    goal:  Optional[str] = None  # optional creator intent, e.g. "punchy hook for Reels"


@app.get("/ai_status")
def ai_status():
    try:
        import ai_flow
        return ai_flow.model_ready()
    except Exception as e:
        return {"runtime": False, "model": False, "error": str(e)}


@app.post("/plan_flow")
def plan_flow_route(req: PlanFlowRequest):
    try:
        import ai_flow
        return ai_flow.plan_flow(req.words, goal=req.goal)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


class PlanEditRequest(BaseModel):
    shots: list[dict]   # [{i, seconds, text}] — one per timeline clip, in order


@app.post("/plan_edit")
def plan_edit_route(req: PlanEditRequest):
    try:
        import ai_flow
        return ai_flow.plan_edit(req.shots)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


def _whisper_available() -> bool:
    try:
        import crisperwhisper  # noqa
        return True
    except ImportError:
        return False


# ── Analyze ────────────────────────────────────────────────────────────────
@app.post("/analyze")
async def start_analyze(req: AnalyzeRequest):
    job_id = str(uuid.uuid4())[:8]
    jobs[job_id] = {"state": "running", "progress": 0, "message": "Queued", "cuts": []}
    asyncio.create_task(_run_analyze(job_id, req))
    return {"job_id": job_id}


@app.get("/status/{job_id}")
def get_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


async def _run_analyze(job_id: str, req: AnalyzeRequest):
    def upd(pct, msg):
        jobs[job_id].update({"progress": pct, "message": msg})

    try:
        # Pick the first media path as the primary audio source.
        # For multi-clip sequences the panel can be extended later to
        # export a mixdown; for MVP we target single-source talking head.
        src = req.media_paths[0]
        if not Path(src).exists():
            raise FileNotFoundError(f"Media not found: {src}")

        # 1. Extract mono WAV ──────────────────────────────────────────────
        upd(10, "Extracting audio…")
        wav_path = _extract_wav(src)
        media_dur = _wav_duration(wav_path)

        # 2. Loudness stats → adaptive threshold suggestion ────────────────
        upd(18, "Measuring levels…")
        loud = _probe_loudness(wav_path)
        suggested_db = _suggested_threshold(loud.get("mean_db"), loud.get("max_db"))

        cuts = []
        cut_id = 0
        silence_method = "none"

        # 3. Transcribe FIRST — needed for speech-gap dead air, fillers, takes
        words = []
        if req.transcribe:
            upd(40, "Transcribing — this takes a moment…")
            words = _transcribe(wav_path)

        # 4. Dead-air detection ────────────────────────────────────────────
        #    Prefer speech gaps (level-independent) when we have a transcript;
        #    otherwise fall back to the audio floor (adaptive or user-set).
        # Only detect dead air when this pass actually wants it. Filler/repeats
        # passes transcribe too, but must NOT emit silence cuts — otherwise a
        # filler word sitting in a pause gets merged into a "silence" cut below
        # and the client's per-kind filter drops it.
        if req.detect_silence:
            upd(60, "Finding dead air…")
            if req.smart_silence and words:
                silence_method = "speech-gaps"
                # dead air = where no one is speaking (transcript gaps) UNION truly
                # silent audio (catches spots the transcriber stray-labeled as words)
                gaps = _find_speech_gaps(words, req.silence_dur, req.padding_ms, media_dur)
                floor = suggested_db if req.auto_threshold else req.silence_db
                audio_sil = _detect_silence(wav_path, db_floor=floor,
                                            min_dur=req.silence_dur, padding_ms=req.padding_ms)
                silence_cuts = _union_ranges(gaps + audio_sil)
            else:
                eff_db = suggested_db if req.auto_threshold else req.silence_db
                silence_method = "auto-threshold" if req.auto_threshold else "fixed-threshold"
                silence_cuts = _detect_silence(wav_path, db_floor=eff_db,
                                               min_dur=req.silence_dur, padding_ms=req.padding_ms)
            for c in silence_cuts:
                cuts.append({
                    "id":       f"s{cut_id}", "type": "silence",
                    "startSec": c["start"],   "endSec": c["end"],
                    "label":    f"{c['dur']:.2f}s dead air",
                    "enabled":  True
                })
                cut_id += 1

        if req.transcribe:
            # 5. Filler word removal ───────────────────────────────────────
            if req.remove_fillers and words:
                upd(70, "Finding filler words…")
                filler_cuts = _find_fillers(words, padding_ms=req.padding_ms,
                                            targets=req.fillers)
                for c in filler_cuts:
                    cuts.append({
                        "id":       f"f{cut_id}", "type": "filler",
                        "startSec": c["start"],   "endSec": c["end"],
                        "label":    c["word"],
                        "enabled":  True
                    })
                    cut_id += 1

            # 5. Repeated take detection ───────────────────────────────────
            if req.detect_takes and words:
                upd(85, "Finding repeated takes…")
                # Prefer the AI (semantic) repeat finder — it catches re-takes
                # that were re-worded, which string matching misses. Fall back to
                # the string method if the local model isn't reachable.
                take_cuts = []
                try:
                    import ai_flow
                    take_cuts = ai_flow.find_repeats(words, keep_last=req.keep_last)
                except Exception:
                    take_cuts = _find_repeated_takes(words, padding_ms=req.padding_ms,
                                                     similarity=req.similarity,
                                                     keep_last=req.keep_last)
                # plus immediate stutters/false-starts (cheap, always useful)
                take_cuts += _find_stutters(words, padding_ms=req.padding_ms)
                for c in take_cuts:
                    cuts.append({
                        "id":       f"t{cut_id}", "type": "repeated_take",
                        "startSec": c["start"],   "endSec": c["end"],
                        "label":    f'"{c["text"][:60]}…"' if len(c["text"]) > 60 else f'"{c["text"]}"',
                        "enabled":  True
                    })
                    cut_id += 1

        # 6. Merge overlapping cuts ────────────────────────────────────────
        cuts = _merge_overlaps(cuts)

        jobs[job_id].update({"state": "done", "progress": 100,
                              "message": f"Found {len(cuts)} cuts", "cuts": cuts,
                              "duration": media_dur, "words": words,
                              "media_path": src,
                              "silence_method": silence_method,
                              "mean_db": loud.get("mean_db"),
                              "max_db": loud.get("max_db"),
                              "suggested_db": suggested_db})

    except Exception as e:
        jobs[job_id].update({"state": "error", "progress": 0, "message": str(e)})
    finally:
        # Clean temp files
        try:
            if 'wav_path' in dir():
                Path(wav_path).unlink(missing_ok=True)
        except Exception:
            pass


# ── Audio extraction ───────────────────────────────────────────────────────
def _wav_duration(wav: str) -> Optional[float]:
    """Duration of the extracted 16 kHz mono WAV, in seconds."""
    try:
        with wave.open(wav, "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate() or 16000
            return frames / float(rate)
    except Exception:
        return None


def _extract_wav(src: str) -> str:
    if not FFMPEG:
        raise RuntimeError(
            "ffmpeg not found. Install it (brew install ffmpeg) or "
            "pip install imageio-ffmpeg into this environment."
        )
    tmp = tempfile.mktemp(suffix=".wav")
    cmd = [
        FFMPEG, "-y", "-i", src,
        "-ac", "1", "-ar", "16000",
        "-acodec", "pcm_s16le",
        tmp
    ]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {r.stderr.decode()[:300]}")
    return tmp


# ── Loudness stats + adaptive threshold ────────────────────────────────────
def _probe_loudness(wav: str) -> dict:
    """Mean/peak loudness (dBFS) of the whole clip via ffmpeg volumedetect."""
    r = subprocess.run([FFMPEG, "-i", wav, "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True)
    err = r.stderr
    out = {"mean_db": None, "max_db": None}
    m = re.search(r"mean_volume:\s*(-?[\d.]+)\s*dB", err)
    if m: out["mean_db"] = float(m.group(1))
    m2 = re.search(r"max_volume:\s*(-?[\d.]+)\s*dB", err)
    if m2: out["max_db"] = float(m2.group(1))
    return out


def _suggested_threshold(mean_db: Optional[float], max_db: Optional[float]) -> float:
    """Derive a silence floor from the clip's own level: speech sits above the
    mean, the silence floor below it. Put the cutoff a healthy margin under the
    average so a quiet talker isn't cut, and clamp to a sane window. This adapts
    to the whole clip being quiet (low mean → low floor) — but note it can't
    catch *loud* dead air; the speech-gap path (transcript) does that."""
    if mean_db is None:
        return -40.0
    thr = mean_db - 16.0
    return round(max(-55.0, min(-18.0, thr)), 1)


# ── Speech-gap (transcript-based) dead-air detection ───────────────────────
def _find_speech_gaps(words: list[dict], min_dur: float, padding_ms: int,
                      total_dur: Optional[float]) -> list[dict]:
    """Dead air = stretches with NO transcribed words longer than min_dur.
    Level-independent: catches loud non-speech (music, room noise) and never
    cuts a quiet talker (their words are still transcribed). Includes the
    lead-in before the first word and the tail after the last word."""
    pad = padding_ms / 1000.0
    gaps = []
    prev_end = 0.0
    for w in words:
        s = w["start"]
        if s - prev_end >= min_dur:
            gs = max(0.0, prev_end + pad)
            ge = s - pad
            if ge - gs > 0.05:
                gaps.append({"start": gs, "end": ge, "dur": ge - gs})
        prev_end = max(prev_end, w["end"])
    if total_dur and (total_dur - prev_end) >= min_dur:
        gs = prev_end + pad
        ge = total_dur
        if ge - gs > 0.05:
            gaps.append({"start": gs, "end": ge, "dur": ge - gs})
    return gaps


def _union_ranges(ranges: list[dict]) -> list[dict]:
    """Merge overlapping/adjacent {start,end,dur} ranges into a union."""
    if not ranges:
        return []
    rs = sorted(ranges, key=lambda r: r["start"])
    out = [dict(rs[0])]
    for r in rs[1:]:
        last = out[-1]
        if r["start"] <= last["end"] + 0.02:
            last["end"] = max(last["end"], r["end"])
            last["dur"] = last["end"] - last["start"]
        else:
            out.append(dict(r))
    return out


# ── Silence detection ──────────────────────────────────────────────────────
def _detect_silence(wav: str, db_floor: float, min_dur: float, padding_ms: int) -> list[dict]:
    """Use ffmpeg silencedetect filter, parse output into time ranges."""
    pad = padding_ms / 1000.0
    cmd = [
        FFMPEG, "-i", wav,
        "-af", f"silencedetect=noise={db_floor}dB:duration={min_dur}",
        "-f", "null", "-"
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    output = r.stderr

    silences = []
    start = None
    for line in output.splitlines():
        if "silence_start" in line:
            try:
                start = float(line.split("silence_start: ")[1].split()[0])
            except Exception:
                pass
        elif "silence_end" in line and start is not None:
            try:
                end = float(line.split("silence_end: ")[1].split()[0])
                # Apply padding inward so we don't clip consonants
                s = start + pad
                e = end   - pad
                dur = e - s
                if dur > 0.05:
                    silences.append({"start": s, "end": e, "dur": dur})
                start = None
            except Exception:
                pass

    return silences


# ── Transcription (CrisperWhisper) ────────────────────────────────────────
_whisper_model = None

def _load_whisper():
    global _whisper_model
    if _whisper_model is None:
        try:
            from crisperwhisper import CrisperWhisperModel  # type: ignore
        except ImportError:
            raise RuntimeError(
                "crisperwhisper not installed.\n"
                "Run: pip install git+https://github.com/nyrahealth/CrisperWhisper"
            )
        device = _best_device()
        _whisper_model = CrisperWhisperModel(
            "nyralabs/CrisperWhisper2.0_large",
            # Force the HF Transformers backend. The default "auto" prefers
            # CTranslate2 (ct2), which needs a separately-converted CT2 model
            # ("no model ctranslate2") and, on Apple Silicon, can't use the GPU
            # anyway — CTranslate2 has no MPS support. Transformers runs on MPS.
            backend="transformers",
            device=device,
            compute_type="float16" if device in ("cuda", "mps") else "float32",
        )
    return _whisper_model


def _cuda_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


def _mps_available() -> bool:
    try:
        import torch
        return torch.backends.mps.is_available()
    except (ImportError, AttributeError):
        return False


def _best_device() -> str:
    if _cuda_available():
        return "cuda"
    if _mps_available():
        return "mps"
    return "cpu"


def _transcribe(wav: str) -> list[dict]:
    """Returns list of {word, start, end} dicts."""
    model = _load_whisper()
    result = model.transcribe(
        wav,
        language="en",
        mode="verbatim",          # Keep fillers, disfluencies
        word_timestamps=True,
    )
    words = []
    for w in (result.words or []):
        if w.start is None or w.end is None:
            continue
        words.append({
            "word":  w.word.strip().lower(),
            "start": w.start,
            "end":   w.end,
        })
    return words


# ── Filler word detection ──────────────────────────────────────────────────
SAFE_FILLERS = {"um", "uh", "er", "err", "em", "hmm", "hm", "mm", "mhm"}

def _clean_word(w: str) -> str:
    # CrisperWhisper's verbatim mode wraps disfluencies in brackets ("[uh]"),
    # so strip brackets alongside punctuation.
    return w.strip(" .,?!-—[](){}").lower()

def _find_fillers(words: list[dict], padding_ms: int,
                  targets: Optional[list[str]] = None) -> list[dict]:
    """Cut the words/phrases the user selected. `targets` may include multi-word
    phrases ("you know", "kind of"); those are matched across consecutive words.
    Falls back to the built-in disfluency set when no targets are given."""
    pad = padding_ms / 1000.0
    source = targets if targets is not None else SAFE_FILLERS   # [] means "none", not "default"
    phrases = [t.strip().lower() for t in source if t and t.strip()]
    singles = {p for p in phrases if " " not in p}
    multis  = sorted((p.split() for p in phrases if " " in p), key=len, reverse=True)

    cleaned = [_clean_word(w["word"]) for w in words]
    n = len(words)
    used = [False] * n
    cuts = []
    i = 0
    while i < n:
        hit = None
        for tokens in multis:                       # longest phrases first
            L = len(tokens)
            if i + L <= n and cleaned[i:i + L] == tokens and not any(used[i:i + L]):
                hit = (i, L, " ".join(tokens))
                break
        if hit is None and cleaned[i] in singles and not used[i]:
            hit = (i, 1, cleaned[i])
        if hit:
            j, L, label = hit
            cuts.append({
                "start": max(0, words[j]["start"] - pad * 0.5),
                "end":   words[j + L - 1]["end"] + pad * 0.5,
                "word":  label,
            })
            for k in range(j, j + L):
                used[k] = True
            i = j + L
        else:
            i += 1
    return cuts


# ── Repeated take detection ────────────────────────────────────────────────
def _find_repeated_takes(words: list[dict], padding_ms: int,
                          min_words: int = 4, similarity: float = 0.82,
                          max_gap_sec: float = 8.0, keep_last: bool = True) -> list[dict]:
    """
    Sliding window over transcript words. When a window matches an earlier one,
    the phrase is being re-taken. We gather EVERY restart of that phrase into a
    cluster and collapse the whole run to a single kept take:

      * keep_last=True  → keep the final restart WHOLE, cut everything before it
      * keep_last=False → keep the first take, cut everything after it

    Fix 1 (keep final take whole): the cut ends exactly at the last restart's
    first word, so the kept take can't be eaten by interior self-similarity.
    Fix 2 (snap to word gaps): every cut edge lands in the silence BETWEEN words,
    so a partial word of the kept take is never clipped.
    """
    pad = padding_ms / 1000.0
    n   = len(words)
    cuts = []

    def window_text(i, length):
        return " ".join(w["word"].strip(".,?!").lower() for w in words[i:i+length])

    # Snap a cut START into the gap before `idx` (never inside the previous word).
    def snap_before(idx):
        start = words[idx]["start"]
        prev_end = words[idx - 1]["end"] if idx > 0 else 0.0
        # sit `pad` before the kept word, but not back into the previous word
        return max(prev_end, start - pad)

    # Snap a cut END to strictly BEFORE the kept word `idx`. When the removed
    # word and the kept word are back-to-back (no gap), the boundary is a
    # float coin-flip — a 20ms bias guarantees the kept word survives.
    def snap_end(idx):
        return words[idx]["start"] - 0.02

    used = [False] * n
    i = min_words
    while i < n - min_words:
        if used[i]:
            i += 1
            continue

        cur_text = window_text(i, min_words)

        # Find the nearest earlier window this one repeats.
        match_j = None
        for j in range(max(0, i - 60), i - min_words + 1):
            if used[j] or words[i]["start"] - words[j]["end"] > max_gap_sec:
                continue
            if SequenceMatcher(None, window_text(j, min_words), cur_text).ratio() >= similarity:
                match_j = j
                break

        if match_j is None:
            i += 1
            continue

        # The repeated phrase P starts at match_j. A restart is any position whose
        # window matches P (P begins with a specific word, so only true phrase
        # starts match — interior words never do). Gather the consecutive cluster.
        phrase = window_text(match_j, min_words)
        starts = [match_j]
        k = match_j + min_words       # skip the rest of THIS take before hunting the next
        while k < n - min_words + 1:
            if words[k]["start"] - words[starts[-1]]["end"] > max_gap_sec:
                break
            if SequenceMatcher(None, window_text(k, min_words), phrase).ratio() >= similarity:
                starts.append(k)
                k += min_words        # a take is ≥ min_words long — jump past its start region
            else:
                k += 1

        if len(starts) < 2:
            i += 1
            continue

        if keep_last:
            # Fix 3b: re-anchor to the TRUE sentence start. The matched window can
            # begin mid-sentence (e.g. anchored on "truly feels like we" so the
            # kept take loses its leading "it"). If every restart shares the same
            # preceding word, that word is the real opening — shift ALL restarts
            # left, repeatedly, until they'd cross a sentence end or the preceding
            # words disagree. This keeps "it truly feels…" whole, not "truly…".
            while (all(s > 0 for s in starts)
                   and not any(words[s - 1]["word"].strip().endswith((".", "!", "?")) for s in starts)
                   and len({words[s - 1]["word"].strip(".,?!").lower() for s in starts}) == 1):
                starts = [s - 1 for s in starts]

            first, last = starts[0], starts[-1]
            # Fix 3a: swallow a short leading false-start that runs straight into
            # the first clean take with no real breath — e.g. "i it feels like"
            # before "it truly feels like…". Extend left over up to min_words
            # words as long as each gap is tiny (a genuine run-on, not a new
            # sentence) and we don't cross a sentence-ending period.
            ext, steps = first, 0
            while (ext > 0 and steps < min_words
                   and words[ext]["start"] - words[ext - 1]["end"] < 0.85
                   and not words[ext - 1]["word"].strip().endswith((".", "!", "?"))):
                ext -= 1
                steps += 1
            first = ext
            # keep the final restart WHOLE → cut [first restart, last restart)
            cut_start = snap_before(first)
            cut_end   = snap_end(last)      # strictly before the kept word
            kept_from = last
        else:
            # keep the first take → cut from the 2nd restart to the end of the
            # last take (≈ last restart + one take length).
            first, last = starts[0], starts[-1]
            take_len  = starts[1] - starts[0]
            end_idx   = min(n - 1, last + take_len - 1)
            cut_start = snap_before(starts[1])
            cut_end   = min(words[end_idx]["end"] + pad,
                            words[end_idx + 1]["start"] if end_idx + 1 < n else words[end_idx]["end"] + pad)
            kept_from = end_idx + 1

        if cut_end - cut_start > 0.2:
            cuts.append({"start": cut_start, "end": cut_end, "text": phrase})

        # Consume the whole cluster; resume scanning at the kept take.
        for m in range(first, min(n, last + min_words)):
            used[m] = True
        i = max(kept_from, i + 1)

    return cuts


# ── Fix 3: stutters / immediate short repeats ──────────────────────────────
def _find_stutters(words: list[dict], padding_ms: int,
                   max_phrase: int = 4, similarity: float = 0.85) -> list[dict]:
    """
    Immediate back-to-back repeats that the take detector (min 4 words) misses:
    a run of 1–max_phrase words directly followed by a near-identical run, with
    little or no pause between them ("we have we have", "you have you have",
    "the the"). Cut the FIRST run, keep the second. Longer phrases win so we
    collapse the largest stutter at each spot.
    """
    pad = padding_ms / 1000.0
    n = len(words)
    cuts = []

    def norm(idx):
        return words[idx]["word"].strip(".,?!").lower()

    i = 0
    while i < n:
        hit = 0
        for L in range(max_phrase, 0, -1):
            if i + 2 * L > n:
                continue
            # The two runs must be an IMMEDIATE repeat — a real stutter has almost
            # no gap. A larger gap or a sentence-ending period between them means
            # it's a breath or intentional repetition ("being nice. being nice
            # today…"), not a stutter — leave it.
            if words[i + L]["start"] - words[i + L - 1]["end"] > 0.3:
                continue
            if words[i + L - 1]["word"].strip().endswith((".", "!", "?")):
                continue
            a = " ".join(norm(i + x)     for x in range(L))
            b = " ".join(norm(i + L + x) for x in range(L))
            if not a or not b:
                continue
            if a == b or SequenceMatcher(None, a, b).ratio() >= similarity:
                hit = L
                break
        if hit:
            cut_start = max(0.0, words[i]["start"] - pad)
            cut_end   = words[i + hit]["start"] - 0.02  # strictly before the kept run
            prev_end  = words[i - 1]["end"] if i > 0 else 0.0
            cut_start = max(prev_end, cut_start)       # snap into the gap
            if cut_end - cut_start > 0.05:
                cuts.append({"start": cut_start, "end": cut_end,
                             "text": a + " (stutter)"})
            i += hit                                    # re-examine from the kept run
        else:
            i += 1
    return cuts


# ── Merge overlapping cuts ─────────────────────────────────────────────────
def _merge_overlaps(cuts: list[dict]) -> list[dict]:
    if not cuts:
        return cuts
    sorted_cuts = sorted(cuts, key=lambda c: c["startSec"])
    merged = [sorted_cuts[0].copy()]
    for c in sorted_cuts[1:]:
        last = merged[-1]
        if c["startSec"] <= last["endSec"] + 0.05:
            # Merge: extend end. Keep a MEANINGFUL type — never let silence
            # override a filler/repeat, or the client's per-kind filter would
            # drop the merged cut and that word would never be removed.
            last["endSec"] = max(last["endSec"], c["endSec"])
            if last["type"] == "silence" and c["type"] != "silence":
                last["type"]  = c["type"]
                last["label"] = c.get("label", last.get("label"))
        else:
            merged.append(c.copy())
    return merged


# ── Build edit file (FCP7 XML) ─────────────────────────────────────────────
# Premiere's UXP API can't razor/ripple/insert on the timeline, so we build the
# tightened cut as a Final Cut Pro 7 (xmeml) file that Premiere imports as a new,
# fully-editable sequence — one clipitem per kept segment, laid end-to-end.
class BuildXmlRequest(BaseModel):
    media_path: str
    seq_name:   str
    cuts:       list[dict]
    duration:   Optional[float] = None
    padding_ms: int = 80


def _probe_media(src: str) -> dict:
    """Probe fps / dimensions / duration / audio via ffmpeg -i (stderr)."""
    r = subprocess.run([FFMPEG, "-i", src], capture_output=True, text=True)
    err = r.stderr
    info = {"width": 1920, "height": 1080, "fps": 30.0,
            "duration": None, "channels": 2, "has_audio": False}

    m = re.search(r"([\d.]+)\s*fps", err)
    if m:
        try: info["fps"] = float(m.group(1))
        except ValueError: pass

    mv = re.search(r"Video:[^\n]*?(\d{2,5})x(\d{2,5})", err)
    if mv:
        info["width"], info["height"] = int(mv.group(1)), int(mv.group(2))

    if "Audio:" in err:
        info["has_audio"] = True
        info["channels"] = 1 if "mono" in err else 2

    md = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", err)
    if md:
        info["duration"] = int(md.group(1)) * 3600 + int(md.group(2)) * 60 + float(md.group(3))

    fps = info["fps"]
    ntsc = abs(fps - round(fps)) > 0.01              # 29.97/23.976/59.94 → NTSC
    info["ntsc"] = ntsc
    info["timebase"] = int(round(fps * 1001 / 1000.0)) if ntsc else int(round(fps))
    return info


def _invert_cuts(cuts: list[dict], total: float) -> list[dict]:
    """Keep ranges = the complement of the cut ranges over [0, total]."""
    ranges = sorted(((c["startSec"], c["endSec"]) for c in cuts), key=lambda x: x[0])
    keeps, cursor = [], 0.0
    for s, e in ranges:
        if s > cursor + 0.001:
            keeps.append({"start": cursor, "end": s})
        cursor = max(cursor, e)
    if cursor < total - 0.001:
        keeps.append({"start": cursor, "end": total})
    return keeps


def _build_fcp7_xml(media_path: str, seq_name: str, keeps: list[dict], p: dict) -> str:
    tb   = p["timebase"]
    NTSC = "TRUE" if p["ntsc"] else "FALSE"
    fr   = tb * (1000.0 / 1001.0 if p["ntsc"] else 1.0)   # true frame rate
    to_f = lambda sec: int(round(sec * fr))
    w, h = p["width"], p["height"]
    ch   = p.get("channels", 2)
    has_audio = p.get("has_audio", True)
    src_dur_f = to_f(p["duration"]) if p.get("duration") else to_f(keeps[-1]["end"])
    fname = os.path.basename(media_path)
    pathurl = "file://localhost" + urllib.parse.quote(media_path)
    esc = lambda s: _sx.escape(str(s))
    rate = f"<rate><timebase>{tb}</timebase><ntsc>{NTSC}</ntsc></rate>"

    file_full = (
        f'<file id="file-1"><name>{esc(fname)}</name>'
        f'<pathurl>{esc(pathurl)}</pathurl>{rate}<duration>{src_dur_f}</duration>'
        f'<media><video><samplecharacteristics>{rate}'
        f'<width>{w}</width><height>{h}</height></samplecharacteristics></video>'
        + (f'<audio><samplecharacteristics><depth>16</depth>'
           f'<samplerate>48000</samplerate></samplecharacteristics>'
           f'<channelcount>{ch}</channelcount></audio>' if has_audio else '')
        + '</media></file>'
    )

    v_items, a_items, tl = [], [], 0
    for i, k in enumerate(keeps):
        in_f, out_f = to_f(k["start"]), to_f(k["end"])
        seg = out_f - in_f
        if seg <= 0:
            continue
        start, end = tl, tl + seg
        tl = end
        fileref = file_full if i == 0 else '<file id="file-1"/>'
        links = (
            f'<link><linkclipref>v{i}</linkclipref><mediatype>video</mediatype>'
            f'<trackindex>1</trackindex><clipindex>{i+1}</clipindex></link>'
            + (f'<link><linkclipref>a{i}</linkclipref><mediatype>audio</mediatype>'
               f'<trackindex>1</trackindex><clipindex>{i+1}</clipindex></link>' if has_audio else '')
        )
        v_items.append(
            f'<clipitem id="v{i}"><name>{esc(fname)}</name><enabled>TRUE</enabled>'
            f'<duration>{src_dur_f}</duration>{rate}'
            f'<start>{start}</start><end>{end}</end><in>{in_f}</in><out>{out_f}</out>'
            f'{fileref}{links}</clipitem>'
        )
        if has_audio:
            a_items.append(
                f'<clipitem id="a{i}"><name>{esc(fname)}</name><enabled>TRUE</enabled>'
                f'<duration>{src_dur_f}</duration>{rate}'
                f'<start>{start}</start><end>{end}</end><in>{in_f}</in><out>{out_f}</out>'
                f'<file id="file-1"/>'
                f'<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>'
                f'{links}</clipitem>'
            )

    audio_media = (
        '<audio><format><samplecharacteristics><depth>16</depth>'
        '<samplerate>48000</samplerate></samplecharacteristics></format>'
        f'<track>{"".join(a_items)}</track></audio>' if has_audio else ''
    )

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">'
        f'<sequence id="clipcutter-seq"><name>{esc(seq_name)}</name>'
        f'<duration>{tl}</duration>{rate}'
        '<media><video><format><samplecharacteristics>'
        f'{rate}<width>{w}</width><height>{h}</height></samplecharacteristics></format>'
        f'<track>{"".join(v_items)}</track></video>'
        f'{audio_media}</media>'
        f'<timecode>{rate}<frame>0</frame><displayformat>NDF</displayformat></timecode>'
        '</sequence></xmeml>'
    )


@app.post("/build_xml")
def build_xml(req: BuildXmlRequest):
    if not Path(req.media_path).exists():
        raise HTTPException(400, f"Media not found: {req.media_path}")

    probe = _probe_media(req.media_path)
    total = req.duration or probe.get("duration")
    if not total or total <= 0:
        raise HTTPException(400, "Could not determine media duration.")

    keeps = _invert_cuts(req.cuts, total)
    if not keeps:
        raise HTTPException(400, "Nothing left to keep after applying all cuts.")

    xml_str = _build_fcp7_xml(req.media_path, req.seq_name, keeps, probe)
    out = Path(tempfile.gettempdir()) / f"clipcutter_{uuid.uuid4().hex[:8]}.xml"
    out.write_text(xml_str, encoding="utf-8")
    return {"xml_path": str(out), "segments": len(keeps)}


@app.post("/probe")
def probe(req: ProbeRequest):
    if not Path(req.media_path).exists():
        raise HTTPException(400, f"Media not found: {req.media_path}")
    return _probe_media(req.media_path)


# ── Debug: capability scan dump (temporary dev aid) ───────────────────────
# The plugin silently POSTs a full, unfiltered dump of live-introspected
# Premiere UXP method names here on load, so real editing-API capability can
# be confirmed by reading this file — no console copy/paste needed.
@app.post("/debug_log")
async def debug_log(request: Request):
    body = await request.json()
    # fixed path next to the server so it's easy to locate regardless of TMPDIR
    out = Path(__file__).resolve().parent / "clipcutter_debug.json"
    out.write_text(json.dumps(body, indent=2), encoding="utf-8")
    return {"ok": True, "path": str(out)}


# ── Entry point ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    print("ClipCutter helper starting on http://localhost:7742")
    _dev = _best_device()
    _gpu_label = {"cuda": "yes (CUDA)", "mps": "yes (Metal/MPS)"}.get(_dev, "no (CPU mode — slower)")
    print("GPU:", _gpu_label)
    print("ffmpeg:", FFMPEG if FFMPEG else "NOT found — install ffmpeg or imageio-ffmpeg")
    print("CrisperWhisper:", "installed" if _whisper_available() else "NOT installed — transcription disabled")
    uvicorn.run(app, host="127.0.0.1", port=7742, log_level="warning")
