# ClipCutter

Premiere (UXP) plugin that removes silences, filler words (um/uh/er), and
repeated takes from your timeline — non-destructively, with a review step before
anything touches your edit.

---

## What you need

- **Adobe Premiere 2026** (v25.6+) with UXP enabled
- **UXP Developer Tool** — install from Creative Cloud Desktop
- **Python 3.10+**
- **ffmpeg** — on your PATH (`brew install ffmpeg` / `choco install ffmpeg`)
- A GPU is optional but makes transcription ~10× faster

---

## One-time setup

### 1. Install the Python helper

```bash
cd helper
pip install -r requirements.txt
pip install git+https://github.com/nyrahealth/CrisperWhisper
```

> If you don't want transcription (silence-only mode), skip the CrisperWhisper
> line — the plugin still works, just disable the "Transcribe" toggle.

### 2. Start the helper

```bash
python helper/server.py
```

You should see:
```
ClipCutter helper starting on http://localhost:7742
GPU: yes (CUDA)
CrisperWhisper: installed
```

Keep this terminal open while you edit. The helper must be running before you click Analyze.

### 3. Load the plugin in Premiere

1. Open **Premiere → Window → UXP Plugins → UXP Developer Tool**
2. Click **Add Plugin**
3. Navigate to `plugin/manifest.json` and click Open
4. Click **Load** (or **Load & Watch** for auto-reload during development)
5. The ClipCutter panel appears under **Window → UXP Plugins → ClipCutter**

---

## Using it

1. Open a sequence with your talking-head footage
2. Open the ClipCutter panel
3. The green dot in the header confirms the helper is running
4. Adjust the sliders if needed (defaults are good for most footage)
5. Click **Analyze sequence**
6. Review the cut list — toggle off anything you want to keep
7. Click **Build new sequence →**

Your original sequence is never modified. ClipCutter creates a new sequence
named `[original name] — ClipCutter`.

---

## The cut types

| Tag | What it is |
|---|---|
| SILENCE | Gap below your dB floor, longer than min silence |
| FILLER | um / uh / er / hmm and variants |
| REPEAT | Repeated take — earlier attempt at the same sentence |

Repeated take detection marks the **earlier** stumbled attempt for removal and
keeps the final clean version. It catches back-to-back restarts within 8 seconds.
It does not attempt to compare takes separated by minutes (that needs the AI layer).

---

## Silence-only mode (instant, no model needed)

Uncheck **Transcribe (CrisperWhisper)** before analyzing. The plugin will run
ffmpeg only — takes 2–3 seconds per clip, no model download required. You get
silence removal but no filler or take detection.

---

## First run note

The first time you click Analyze with transcription on, CrisperWhisper downloads
its model weights (~3 GB). This only happens once. Subsequent runs load from cache.

---

## Troubleshooting

**Red dot / "Helper not running"**  
Start `python helper/server.py` in a terminal and leave it open.

**"No clips found on video track 1"**  
ClipCutter reads Video Track 1. Make sure your footage is on V1.

**"Media not found"**  
The media path Premiere reports must be accessible from the machine running the
helper. If you're on a shared/NAS drive, mount it the same way.

**Transcription is very slow**  
No GPU detected. It still works on CPU but a 10-minute clip may take 4–5 minutes.
A GPU (even a modest one) brings this under 30 seconds.

**CrisperWhisper install fails**  
Try: `pip install git+https://github.com/nyrahealth/CrisperWhisper --no-build-isolation`

---

## Project layout

```
clipcutter/
├── plugin/
│   ├── manifest.json   ← Premiere UXP manifest
│   ├── index.html      ← Panel UI
│   ├── style.css       ← Panel styles
│   └── main.js         ← Premiere API + helper calls
└── helper/
    ├── server.py        ← FastAPI server (silence, whisper, take detection)
    └── requirements.txt
```
