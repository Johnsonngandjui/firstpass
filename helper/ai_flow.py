"""
ClipCutter — AI Flow (reorder / b-roll / pacing planner)

Isolated from the cut engine on purpose: this module only READS a transcript and
returns a structured edit *plan*. It never touches the timeline itself — the UXP
panel reviews the plan and decides what to apply.

The LLM call is behind a single swappable function `_chat()`. Today it targets a
local Ollama model; swapping to Claude later means changing only `_chat()`.
"""

import json
import urllib.request
from typing import Optional

# ── Model backend (swap here to change providers) ───────────────────────────
OLLAMA_URL   = "http://localhost:11434"
OLLAMA_MODEL = "qwen2.5:14b-instruct"          # the one local model — filler, flow, dedup


def _chat(system: str, user: str, want_json: bool = True, timeout: int = 600,
          model: str = None) -> str:
    """One chat turn against the local model. Returns the raw assistant text.
    Raises RuntimeError with a clear message if the model/runtime isn't ready."""
    payload = {
        "model": model or OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user},
        ],
        "stream": False,
        # low temperature + fixed seed → the SAME clip gives the SAME arrangement
        # every run (was flip-flopping between reorder / no-reorder before).
        "options": {"temperature": 0.15, "seed": 7, "top_p": 0.9},
    }
    if want_json:
        payload["format"] = "json"

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Local model not reachable at {OLLAMA_URL} ({e}). "
            f"Is Ollama running and '{OLLAMA_MODEL}' pulled?"
        )
    return (data.get("message") or {}).get("content", "")


def model_ready() -> dict:
    """Health probe for the AI-Flow backend: is Ollama up and the model present?"""
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=4) as r:
            tags = json.load(r)
        names = [m.get("name", "") for m in tags.get("models", [])]
        have = any(n == OLLAMA_MODEL or n.startswith(OLLAMA_MODEL.split(":")[0]) for n in names)
        return {"runtime": True, "model": have, "model_name": OLLAMA_MODEL, "installed": names}
    except Exception as e:
        return {"runtime": False, "model": False, "model_name": OLLAMA_MODEL, "error": str(e)}


def loaded_models() -> list[str]:
    """Names of models Ollama currently holds in memory (the big ones eat RAM)."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/ps", timeout=4) as r:
            return [m.get("name", "") for m in json.load(r).get("models", [])]
    except Exception:
        return []


def unload_models() -> dict:
    """Evict ClipCutter's local models from memory so Premiere gets the RAM back
    for smooth editing. Uses Ollama's keep_alive:0 (an empty generate call that
    tells the runtime to drop the model immediately). Safe if already unloaded."""
    freed = []
    for m in (OLLAMA_MODEL,):
        try:
            req = urllib.request.Request(
                f"{OLLAMA_URL}/api/generate",
                data=json.dumps({"model": m, "keep_alive": 0}).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=15):
                pass
            freed.append(m)
        except Exception:
            pass
    return {"freed": freed, "still_loaded": loaded_models()}


# ── Transcript → reorderable segments ───────────────────────────────────────
def segment_transcript(words: list[dict], hard_pause: float = 1.4,
                       min_words: int = 4) -> list[dict]:
    """Group words into FULL-SENTENCE segments (the unit we reorder). We break on
    sentence-ending punctuation; a long pause is only a fallback break when a run
    has grown without punctuation. Then any stray fragment (too short, or not a
    complete sentence) is merged into its neighbour so every segment is a whole
    thought — never a handful of loose words."""
    groups, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        text = (w.get("word") or "").strip()
        ends_sentence = text.endswith((".", "!", "?"))
        next_gap = (words[i + 1]["start"] - w["end"]) if i + 1 < len(words) else 999
        # split on a full sentence, or a big breath after enough words
        if ends_sentence or (next_gap >= hard_pause and len(cur) >= min_words):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)

    def gtext(g):
        return " ".join((x.get("word") or "").strip() for x in g).strip()

    # Merge fragments: a group that is too short OR doesn't end a sentence gets
    # folded into the previous whole thought (or the next, if it's the first).
    merged = []
    for g in groups:
        if not gtext(g):
            continue
        wc = len(gtext(g).split())
        ends = gtext(g).rstrip().endswith((".", "!", "?"))
        is_fragment = wc < min_words or not ends
        if is_fragment and merged:
            merged[-1] = merged[-1] + g          # fold into previous sentence
        else:
            merged.append(g)
    # if the very first group was a fragment with nothing before it, fold forward
    if len(merged) >= 2 and len(gtext(merged[0]).split()) < min_words:
        merged[1] = merged[0] + merged[1]
        merged.pop(0)

    out = []
    for idx, g in enumerate(merged, start=1):
        out.append({
            "id":    idx,
            "start": round(g[0]["start"], 2),
            "end":   round(g[-1]["end"], 2),
            "text":  gtext(g),
        })
    return out


# ── The plan ────────────────────────────────────────────────────────────────
_SYSTEM = (
    "You are a senior short-form video story editor. You are given the ordered "
    "spoken segments of a talking-head clip that has already had silence, filler "
    "words, and repeated takes removed. Your job: GROUP the segments into a few "
    "coherent topics, and ARRANGE those topics into a clear, compelling story the "
    "viewer can easily follow — a strong hook, a logical build, a satisfying "
    "close. You never invent, reword, or drop content; you only group and reorder "
    "the existing segments so each part of the video has one well-defined topic."
)

_SCHEMA_INSTRUCTIONS = """Return ONLY valid JSON with exactly this shape:
{
  "topics": [
    {"title": "<2-4 word topic label>",
     "segment_ids": [<ids in this topic, in the best order within it>],
     "why": "<why this topic sits at this point in the story>"}
  ],
  "hook":  {"segment_id": <id>, "why": "<why it opens strongest>"},
  "broll": [{"after_segment": <id>, "idea": "<what to show>", "why": "<why>"}],
  "pacing":[{"after_segment": <id>, "action": "pause"|"tighten", "seconds": <number>, "why": "<why>"}],
  "notes": "<one sentence describing the resulting story arc>",
  "warnings": ["<continuity risks introduced by regrouping/reordering>"]
}

Rules:
- Every segment id MUST appear in exactly ONE topic's segment_ids. Never drop or
  duplicate a segment.
- ALWAYS group by MEANING/theme, not by recording position — actively pull
  related ideas together even when they were far apart in the recording. This
  regrouping is the whole point; do not just echo the original order.
- Use 2-5 topics. Order the topics to tell the best story; the FIRST segment of
  the FIRST topic is the hook.
- Within a topic, order segments so they read naturally.
- Only keep the original order if the segments are ALREADY perfectly grouped by
  topic — which is rare. Otherwise regroup.
- Flag continuity risks (back-references like "as I said", tone/topic jumps)
  in "warnings". "after_segment" ids refer to segment ids.
"""


def _loads(raw: str) -> dict:
    """Parse a JSON object out of a model reply, tolerating prose wrappers."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        a, b = raw.find("{"), raw.rfind("}")
        if a == -1 or b == -1:
            raise RuntimeError(f"Model did not return JSON. Got: {raw[:200]}")
        return json.loads(raw[a:b + 1])


def _cleanest(ids: list[int], by_id: dict) -> int:
    """Pick the cleanest take of a re-take group: prefer one that ends as a full
    sentence, with the fewest [uh]/[um] fillers, then the most complete (longest)."""
    def score(i):
        t = (by_id[i]["text"] or "").strip()
        ends = t.endswith((".", "!", "?"))
        fillers = t.count("[uh]") + t.count("[um]")
        return (ends, -fillers, len(t))
    return max(ids, key=score)


def _dedup_segments(segments: list[dict]):
    """Find repeated takes (14B clustering) and drop all but the cleanest of each.
    Returns (survivor_ids_in_order, dropped_ids, groups)."""
    if len(segments) < 2:
        return [s["id"] for s in segments], [], []
    lines = "\n".join(f'[{s["id"]}] "{s["text"]}"' for s in segments)
    plan = _loads(_chat(_REPEATS_SYSTEM, f"{_REPEATS_SCHEMA}\nSegments:\n{lines}",
                        want_json=True)) or {"groups": []}
    by_id = {s["id"]: s for s in segments}
    dropped, groups_out, used = [], [], set()
    for g in (plan.get("groups") or []):
        ids = [i for i in (g.get("segment_ids") or []) if i in by_id and i not in used]
        if len(ids) < 2:
            continue
        # Always pick the cleanest ourselves — the model's own "keep" is unreliable
        # (it kept a garbled false-start over the clean re-take), so we trust the
        # heuristic: prefer a complete sentence, fewest [uh]/[um], most complete.
        keep = _cleanest(ids, by_id)
        for i in ids:
            used.add(i)
            if i != keep:
                dropped.append(i)
        groups_out.append({"ids": ids, "keep": keep})
    survivors = [s["id"] for s in segments if s["id"] not in dropped]
    return survivors, sorted(dropped), groups_out


def plan_flow(words: list[dict], goal: Optional[str] = None) -> dict:
    """AI Flow = coherent cut + story arrange, both on the 14B model:
      1. remove REPEATED TAKES (keep the cleanest of each re-said line), then
      2. group the survivors by topic and arrange them into a story.
    Returns the plan plus the FULL segment table so the panel can map ids→timecode
    (dropped takes stay in the table but are excluded from `order`)."""
    segments = segment_transcript(words)
    if len(segments) < 2:
        return {"segments": segments, "plan": None,
                "message": "Not enough distinct segments to arrange."}

    # 1. Coherent cut — drop repeated takes.
    survivor_ids, dropped_ids, groups = _dedup_segments(segments)
    survivor_segs = [s for s in segments if s["id"] in survivor_ids]

    # 2. Story arrange the survivors.
    if len(survivor_segs) >= 2:
        seg_lines = "\n".join(
            f'[{s["id"]}] ({s["start"]:.1f}-{s["end"]:.1f}s) "{s["text"]}"' for s in survivor_segs
        )
        plan = _loads(_chat(_SYSTEM, f"{_SCHEMA_INSTRUCTIONS}\nSegments:\n{seg_lines}",
                            want_json=True))
        plan = _validate_plan(plan, survivor_segs)
    else:
        plan = _validate_plan({"topics": []}, survivor_segs)

    # 3. Attach what the cut removed so the panel can show it.
    by = {s["id"]: s for s in segments}
    plan["dropped"] = dropped_ids
    plan["removed"] = [{"id": i, "text": by[i]["text"]} for i in dropped_ids if i in by]
    return {"segments": segments, "plan": plan}


def _validate_plan(plan: dict, segments: list[dict]) -> dict:
    """Repair/sanity-check the model output so the panel can trust it:
    - every segment assigned to exactly one topic (first wins; strays appended)
    - derive the flat `order` from the topic grouping"""
    valid_ids = [s["id"] for s in segments]
    valid_set = set(valid_ids)

    topics_in = plan.get("topics") or []
    topics, assigned = [], set()
    for t in topics_in:
        ids = []
        for i in (t.get("segment_ids") or []):
            if i in valid_set and i not in assigned:
                assigned.add(i); ids.append(i)
        if ids:
            topics.append({"title": (t.get("title") or "Topic").strip(),
                           "segment_ids": ids,
                           "why": (t.get("why") or "").strip()})

    # any segment the model forgot → keep it (original order) in an "Other" topic
    leftover = [i for i in valid_ids if i not in assigned]
    if leftover:
        topics.append({"title": "Other", "segment_ids": leftover,
                       "why": "Segments the model did not group — kept in original order."})

    plan["topics"] = topics
    plan["order"]  = [i for t in topics for i in t["segment_ids"]]

    keep = lambda i: i in valid_set
    plan["broll"]  = [b for b in (plan.get("broll")  or []) if keep(b.get("after_segment"))]
    plan["pacing"] = [p for p in (plan.get("pacing") or []) if keep(p.get("after_segment"))]
    if not isinstance(plan.get("warnings"), list):
        plan["warnings"] = []
    plan.setdefault("notes", "")
    plan.setdefault("hook", {})
    plan["reordered"] = plan["order"] != valid_ids
    return plan


# ── AI Edit: cinematography (per-shot camera move) ──────────────────────────
_EDIT_SYSTEM = (
    "You are a cinematographer for short-form talking-head video. You are given "
    "the ordered SHOTS of an edit — each shot is one continuous clip with its "
    "spoken text and duration. For each shot you choose ONE subtle camera move "
    "(scale only) that serves the content and holds attention, WITHOUT overdoing "
    "it. Restraint is the craft: most shots stay static; motion is earned. You "
    "never invent content; you only choose moves."
)

_EDIT_SCHEMA = """Return ONLY valid JSON:
{
  "shots": [
    {"i": <shot index>,
     "move": "static" | "slow_push" | "punch_in" | "hold_close" | "ease_out",
     "from": <start scale %, 100-122>,
     "to":   <end scale %, 100-122>,
     "at_frac": <0.0-1.0, only for punch_in: where in the shot the punch lands>,
     "why": "<one short reason>"}
  ],
  "notes": "<one sentence on the overall visual rhythm>"
}

Move meanings:
- static     : hold at 100%. THE DEFAULT for most shots.
- slow_push  : slow zoom IN across the shot (from~100 to~108-112). Use on a
               building thought or an emotional/personal beat.
- punch_in   : a quick snap zoom on ONE key/emphatic word (to~113-118), then it
               HOLDS at that scale to the end of the sentence (it does NOT zoom
               back out). Use SPARINGLY, only on a real punchline or key word.
- hold_close : sit zoomed in and hold (~108-112). Use on an intimate or intense
               confession.
- ease_out   : slow zoom OUT (from~110 to 100). Use to release tension / wind down.

Rules:
- MOST shots must be "static". Give a real move to at most ~40% of shots.
- Never put two strong moves (punch_in / hold_close) back-to-back — separate them
  with static or a slow move so the video breathes.
- Amounts: pushes +8 to +12%, punches to +13 to +18%, holds +8 to +12%. These
  should be VISIBLE but smooth. Never exceed 122%.
- Reset toward 100% on a new topic / establishing line.
- Every shot index MUST appear exactly once. Vary moves so it feels intentional
  and cinematic — not gimmicky.
"""


def plan_edit(shots: list[dict]) -> dict:
    """shots: [{"i":int, "seconds":float, "text":str}] → per-shot camera moves."""
    if not shots:
        return {"shots": [], "notes": "No shots."}
    lines = "\n".join(
        f'[{s["i"]}] ({s.get("seconds", 0):.1f}s) "{s.get("text", "")}"' for s in shots
    )
    raw = _chat(_EDIT_SYSTEM, f"{_EDIT_SCHEMA}\nShots:\n{lines}", want_json=True)
    try:
        plan = json.loads(raw)
    except json.JSONDecodeError:
        a, b = raw.find("{"), raw.rfind("}")
        if a == -1 or b == -1:
            raise RuntimeError(f"Model did not return JSON. Got: {raw[:200]}")
        plan = json.loads(raw[a:b + 1])
    return _validate_edit(plan, shots)


def _validate_edit(plan: dict, shots: list[dict]) -> dict:
    valid = {s["i"] for s in shots}
    moves = {"static", "slow_push", "punch_in", "hold_close", "ease_out"}
    clamp = lambda v, lo, hi: max(lo, min(hi, v))
    by_i, out = {}, []
    for sh in (plan.get("shots") or []):
        i = sh.get("i")
        if i not in valid or i in by_i:
            continue
        mv = sh.get("move") if sh.get("move") in moves else "static"
        try: frm = clamp(float(sh.get("from", 100)), 100, 122)
        except Exception: frm = 100.0
        try: to = clamp(float(sh.get("to", 100)), 100, 122)
        except Exception: to = 100.0
        if mv == "static": frm = to = 100.0
        try: af = clamp(float(sh.get("at_frac", 0.3)), 0.0, 1.0)
        except Exception: af = 0.3
        rec = {"i": i, "move": mv, "from": round(frm, 1), "to": round(to, 1),
               "at_frac": round(af, 2), "why": (sh.get("why") or "").strip()}
        by_i[i] = rec; out.append(rec)
    # any shot the model skipped → static
    for s in shots:
        if s["i"] not in by_i:
            out.append({"i": s["i"], "move": "static", "from": 100.0, "to": 100.0, "at_frac": 0.3, "why": ""})
    out.sort(key=lambda r: r["i"])
    plan["shots"] = out
    plan.setdefault("notes", "")
    return plan


# ── AI repeated-take detection (semantic, replaces string matching) ──────────
_REPEATS_SYSTEM = (
    "You find REPEATED TAKES in a talking-head transcript — places where the "
    "speaker said the SAME thing more than once because they re-recorded a line, "
    "EVEN IF the wording differs. You group each set of re-takes together and "
    "keep ONE (the cleanest / most complete, usually the LAST), marking the "
    "others for removal. You never group segments that merely share a topic but "
    "actually say something NEW — only true re-takes of the same point."
)

_REPEATS_SCHEMA = """Return ONLY valid JSON:
{
  "groups": [
    {"segment_ids": [<ids that are re-takes of THE SAME thing, 2 or more>],
     "keep": <the id to keep>,
     "why": "<short reason>"}
  ]
}
Rules:
- Only group segments that express the SAME point re-said (a redo), even if the
  words differ. Different points, examples, or new information are NOT repeats.
- "keep" MUST be one of that group's segment_ids. Default to the LAST unless an
  earlier take is clearly more complete.
- If nothing is a re-take, return {"groups": []}.
"""


def find_repeats(words: list[dict], keep_last: bool = True) -> list[dict]:
    """Semantic repeated-take detection. Returns cut ranges [{start,end,text}]
    for the takes to REMOVE (all but the kept one in each re-take group)."""
    segments = segment_transcript(words)
    if len(segments) < 2:
        return []
    lines = "\n".join(f'[{s["id"]}] "{s["text"]}"' for s in segments)
    raw = _chat(_REPEATS_SYSTEM, f"{_REPEATS_SCHEMA}\nSegments:\n{lines}", want_json=True)
    try:
        plan = json.loads(raw)
    except json.JSONDecodeError:
        a, b = raw.find("{"), raw.rfind("}")
        plan = json.loads(raw[a:b + 1]) if a != -1 and b != -1 else {"groups": []}

    by_id = {s["id"]: s for s in segments}
    cuts, used = [], set()
    for g in (plan.get("groups") or []):
        ids = [i for i in (g.get("segment_ids") or []) if i in by_id and i not in used]
        if len(ids) < 2:
            continue
        keep = g.get("keep")
        if keep not in ids:
            keep = ids[-1] if keep_last else ids[0]
        for i in ids:
            used.add(i)
            if i == keep:
                continue
            s = by_id[i]
            cuts.append({"start": s["start"], "end": s["end"], "text": s["text"]})
    return cuts
