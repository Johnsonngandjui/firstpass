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
OLLAMA_MODEL = "qwen2.5:14b-instruct"


def _chat(system: str, user: str, want_json: bool = True, timeout: int = 180) -> str:
    """One chat turn against the local model. Returns the raw assistant text.
    Raises RuntimeError with a clear message if the model/runtime isn't ready."""
    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user},
        ],
        "stream": False,
        "options": {"temperature": 0.4},
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
- Use 2-5 topics. Order the topics to tell the best story; the FIRST segment of
  the FIRST topic is the hook.
- Within a topic, order segments so they read naturally.
- Group by MEANING/theme, not by original position — related ideas belong
  together even if they were far apart in the recording.
- Flag continuity risks (back-references like "as I said", tone/topic jumps)
  in "warnings". "after_segment" ids refer to segment ids.
"""


def plan_flow(words: list[dict], goal: Optional[str] = None) -> dict:
    """Build the topic-grouped story plan from a transcript. Returns the plan plus
    the segment table the UXP panel needs to map ids back to source timecodes."""
    segments = segment_transcript(words)
    if len(segments) < 2:
        return {"segments": segments, "plan": None,
                "message": "Not enough distinct segments to arrange."}

    seg_lines = "\n".join(
        f'[{s["id"]}] ({s["start"]:.1f}-{s["end"]:.1f}s) "{s["text"]}"' for s in segments
    )
    user = f"{_SCHEMA_INSTRUCTIONS}\nSegments:\n{seg_lines}"

    raw = _chat(_SYSTEM, user, want_json=True)
    try:
        plan = json.loads(raw)
    except json.JSONDecodeError:
        # models sometimes wrap JSON in prose — grab the outermost object
        s, e = raw.find("{"), raw.rfind("}")
        if s == -1 or e == -1:
            raise RuntimeError(f"Model did not return JSON. Got: {raw[:200]}")
        plan = json.loads(raw[s:e + 1])

    plan = _validate_plan(plan, segments)
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
