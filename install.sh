#!/usr/bin/env bash
# FirstPass installer — sets up the local helper, the AI model, and the
# background watcher. Safe to re-run: every step is skipped if already done.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/helper/firstpass-env"
PLIST_SRC="$HERE/helper/com.firstpass.helper.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/com.firstpass.helper.plist"
OLLAMA_MODEL="qwen2.5:14b-instruct"
WHISPER_MODEL="nyralabs/CrisperWhisper2.0_large"

bold=$(tput bold 2>/dev/null || true); dim=$(tput dim 2>/dev/null || true)
red=$(tput setaf 1 2>/dev/null || true); grn=$(tput setaf 2 2>/dev/null || true)
ylw=$(tput setaf 3 2>/dev/null || true); rst=$(tput sgr0 2>/dev/null || true)

step() { echo; echo "${bold}▸ $*${rst}"; }
ok()   { echo "  ${grn}✓${rst} $*"; }
warn() { echo "  ${ylw}!${rst} $*"; }
die()  { echo; echo "  ${red}✗ $*${rst}"; echo; exit 1; }

cat <<BANNER

${bold}FirstPass${rst} — local AI editing for Premiere Pro
${dim}Everything runs on this Mac. No account, no API key, nothing uploaded.${rst}
BANNER

# ── 1. Preflight ────────────────────────────────────────────────────────────
step "Checking your system"

[ "$(uname -s)" = "Darwin" ] || die "FirstPass is macOS-only right now."
ok "macOS $(sw_vers -productVersion)"

if [ "$(uname -m)" != "arm64" ]; then
  warn "Intel Mac detected. Transcription and the AI model will be slow (no Metal acceleration)."
else
  ok "Apple Silicon ($(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo arm64))"
fi

RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
if [ "$RAM_GB" -lt 16 ]; then
  warn "${RAM_GB} GB RAM. The 14B model wants ~10 GB — expect swapping, and quit other apps."
else
  ok "${RAM_GB} GB RAM"
fi

# df wraps long device names onto their own line, so take the last row, not row 2.
FREE_GB=$(df -g "$HERE" | tail -1 | awk '{print $4}')
if [ "$FREE_GB" -lt 5 ]; then
  die "Only ${FREE_GB} GB free — not enough to install. Free up some space and re-run."
elif [ "$FREE_GB" -lt 20 ]; then
  warn "${FREE_GB} GB free. A first-time install pulls ~12 GB of models; if you already have them, this is fine."
else
  ok "${FREE_GB} GB free disk"
fi

if [ -d "/Applications/Adobe Premiere Pro 2026" ] || ls -d /Applications/Adobe\ Premiere\ Pro\ * >/dev/null 2>&1; then
  ok "Premiere Pro found"
else
  warn "No Premiere Pro in /Applications. FirstPass needs Premiere 2026 (v25.6+)."
fi

# macOS ships Python 3.9, which is below our floor. If there's nothing newer we
# fetch a private one later rather than stopping — a Mac that has never been
# used for development is the normal case, not an error.
PY_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    if "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
      PY_BIN="$cand"; break
    fi
  fi
done
if [ -n "$PY_BIN" ]; then
  ok "$($PY_BIN -V) at $(command -v "$PY_BIN")"
else
  ok "No Python 3.10+ yet — one will be installed just for FirstPass"
fi

# ── 2. Ollama ───────────────────────────────────────────────────────────────
step "Setting up the local AI model"

# Ollama may be a CLI on PATH or only the .app bundle. Same discovery
# premiere-watch.sh uses, so both agree on which binary to run.
find_ollama() {
  command -v ollama 2>/dev/null && return 0
  for p in /opt/homebrew/bin/ollama /usr/local/bin/ollama \
           /opt/homebrew/opt/ollama/bin/ollama /Applications/Ollama.app/Contents/Resources/ollama; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

OLLAMA="$(find_ollama || true)"
if [ -z "$OLLAMA" ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "  Installing Ollama via Homebrew…"
    brew install ollama
  else
    # No Homebrew: take the official build straight from ollama.com, so this
    # works on a Mac that has never had developer tools on it.
    echo "  Downloading Ollama from ollama.com…"
    TMPDIR_OLLAMA="$(mktemp -d)"
    curl -fL --progress-bar https://ollama.com/download/Ollama-darwin.zip \
      -o "$TMPDIR_OLLAMA/Ollama-darwin.zip" \
      || die "Could not download Ollama. Get it from https://ollama.com/download,
    drag it to Applications, then run this again."
    ditto -x -k "$TMPDIR_OLLAMA/Ollama-darwin.zip" /Applications \
      || die "Could not unpack Ollama into /Applications."
    rm -rf "$TMPDIR_OLLAMA"
    # Anything downloaded is quarantined, and Gatekeeper blocks the first launch
    # of a quarantined binary. This came over HTTPS from Ollama's own release
    # URL, and the user just asked us to install it.
    xattr -dr com.apple.quarantine /Applications/Ollama.app 2>/dev/null || true
    # Record that we installed it, so uninstall.sh knows it's ours to remove.
    touch "$HERE/helper/.ollama-installed-by-firstpass"
  fi
  OLLAMA="$(find_ollama || true)"
fi
[ -n "$OLLAMA" ] || die "Ollama still isn't available after installing it."
ok "Ollama installed"

# The daemon must be up to pull. Start it if it isn't.
if ! curl -s --max-time 2 http://localhost:11434/api/version >/dev/null 2>&1; then
  echo "  Starting the Ollama service…"
  ("$OLLAMA" serve >/dev/null 2>&1 &)
  for _ in $(seq 1 30); do
    curl -s --max-time 2 http://localhost:11434/api/version >/dev/null 2>&1 && break
    sleep 1
  done
fi
curl -s --max-time 2 http://localhost:11434/api/version >/dev/null 2>&1 \
  || die "Ollama won't start. Open the Ollama app once manually, then re-run."
ok "Ollama running"

# Match the full name:tag — matching just "qwen2.5" would accept some other
# variant (7b, base) and silently skip the pull that AI Flow actually needs.
if "$OLLAMA" list 2>/dev/null | grep -qF "$OLLAMA_MODEL"; then
  ok "Model $OLLAMA_MODEL already downloaded"
else
  echo "  Downloading $OLLAMA_MODEL — about 9 GB, this is the long part."
  "$OLLAMA" pull "$OLLAMA_MODEL"
  ok "Model downloaded"
fi

# ── 3. Python helper ────────────────────────────────────────────────────────
step "Installing the transcription helper"

# Pre-rename installs used helper/clipcutter-env. A venv can't just be moved
# (its scripts hardcode absolute paths), so we build a fresh one and point the
# user at the old directory rather than silently leaving ~1 GB behind.
LEGACY_VENV="$HERE/helper/clipcutter-env"
if [ -d "$LEGACY_VENV" ] && [ ! -d "$VENV" ]; then
  warn "Found the old clipcutter-env. Building a fresh firstpass-env; you can reclaim the space with:
      rm -rf \"$LEGACY_VENV\""
fi

if [ ! -x "$VENV/bin/python3" ]; then
  if [ -n "$PY_BIN" ]; then
    "$PY_BIN" -m venv "$VENV"
  else
    # Nothing on this Mac is new enough. uv is a single binary that fetches its
    # own interpreter into the user's home folder: no Homebrew, no admin
    # password, nothing placed anywhere system-wide.
    UV="$(command -v uv 2>/dev/null || true)"
    [ -x "$HOME/.local/bin/uv" ] && UV="$HOME/.local/bin/uv"
    if [ -z "$UV" ]; then
      echo "  Installing a private Python for FirstPass…"
      curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 \
        || die "Could not install uv, which provides the Python.
    Install Python 3.12 from https://www.python.org/downloads/macos/ and run this again."
      UV="$HOME/.local/bin/uv"
      touch "$HERE/helper/.uv-installed-by-firstpass"
    fi
    [ -x "$UV" ] || die "uv did not land where expected ($UV)."
    # --seed puts pip inside the venv; the rest of this script installs with it.
    "$UV" venv --seed --python 3.12 "$VENV" \
      || die "Could not build the environment with uv."
  fi
  ok "Created virtualenv"
else
  ok "Virtualenv already exists"
fi

"$VENV/bin/python3" -m pip install --upgrade pip --quiet
echo "  Installing dependencies (torch is large — a few minutes)…"
"$VENV/bin/python3" -m pip install -r "$HERE/helper/requirements.txt" --quiet
ok "Dependencies installed"

if "$VENV/bin/python3" -c 'import crisperwhisper' 2>/dev/null; then
  ok "CrisperWhisper already installed"
else
  echo "  Installing CrisperWhisper…"
  # Prefer the published package with the transformers backend extra; fall back
  # to the upstream repo if PyPI resolution fails.
  "$VENV/bin/python3" -m pip install --quiet "crisperwhisper[transformers]" \
    || "$VENV/bin/python3" -m pip install --quiet "git+https://github.com/nyrahealth/CrisperWhisper" \
    || die "CrisperWhisper failed to install. Try re-running; if it persists, open an issue."
  ok "CrisperWhisper installed"
fi

# ── 4. Prefetch the speech model ────────────────────────────────────────────
# Otherwise the first Analyze stalls on a silent ~3 GB download and looks broken.
step "Downloading the speech model (~3 GB, one time)"
"$VENV/bin/python3" - <<PY
import sys
try:
    from huggingface_hub import snapshot_download
    snapshot_download("$WHISPER_MODEL")
    print("  done")
except Exception as e:
    print(f"  could not prefetch ({e}); it will download on first use instead")
    sys.exit(0)
PY
ok "Speech model ready"

# ── 5. Background watcher ───────────────────────────────────────────────────
step "Installing the background helper"

mkdir -p "$HOME/Library/LaunchAgents"

# Retire the pre-rename agent first — otherwise two watchers race to bind :7742.
LEGACY_PLIST="$HOME/Library/LaunchAgents/com.clipcutter.helper.plist"
if [ -f "$LEGACY_PLIST" ]; then
  launchctl bootout "gui/$(id -u)/com.clipcutter.helper" 2>/dev/null || true
  rm -f "$LEGACY_PLIST"
  ok "Removed the old ClipCutter helper agent"
fi

sed "s|__FIRSTPASS_DIR__|$HERE|g" "$PLIST_SRC" > "$PLIST_DST"
chmod +x "$HERE/helper/premiere-watch.sh"

AGENT="gui/$(id -u)/com.firstpass.helper"
agent_registered() { launchctl print "$AGENT" >/dev/null 2>&1; }

launchctl bootout "$AGENT" 2>/dev/null || true
# bootout is asynchronous. Bootstrapping while the old job is still unloading
# fails with "Input/output error", so wait for it to actually go away.
for _ in $(seq 1 15); do
  agent_registered || break
  sleep 1
done

# Keep the error: bootstrap's failure reason is the only useful thing to show a
# user whose install silently produced no watcher.
BOOT_ERR="$(launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>&1)" || true

# Trust the registry, not the exit code — the legacy `launchctl load` returns 0
# even when it registers nothing.
if ! agent_registered; then
  launchctl load "$PLIST_DST" 2>/dev/null || true
fi

if agent_registered; then
  ok "Helper will start automatically whenever Premiere is open"
else
  warn "Could not register the LaunchAgent${BOOT_ERR:+ — $BOOT_ERR}
      You can still start the helper by hand with:
      $VENV/bin/python3 $HERE/helper/server.py"
fi

# ── 6. Verify ───────────────────────────────────────────────────────────────
step "Verifying"

if agent_registered; then
  ok "Background watcher registered"
else
  warn "Background watcher is NOT registered — the helper will not start on its own"
fi

# Booting out the old watcher above makes it stop its server, which takes a
# moment. Without this pause the probe below can be answered by that dying
# server and report a healthy install that has nothing left running.
sleep 3

# The watcher only starts the server while Premiere is running, so for this
# check we start it ourselves and shut it down after.
STARTED_FOR_CHECK=""
if ! curl -s --max-time 2 http://localhost:7742/health >/dev/null 2>&1; then
  # Pass server.py by absolute path, matching how premiere-watch.sh launches it:
  # the venv python is a symlink, so the process shows the RESOLVED interpreter
  # and the script path is the only stable thing to match on. A bare "server.py"
  # here would leave both the pkill below and the watcher's stop_server unable to
  # find it — a server that never shuts down when Premiere closes.
  ( cd "$HERE/helper" && "$VENV/bin/python3" "$HERE/helper/server.py" >/dev/null 2>&1 & )
  STARTED_FOR_CHECK=1
  for _ in $(seq 1 45); do
    curl -s --max-time 2 http://localhost:7742/health >/dev/null 2>&1 && break
    sleep 1
  done
fi

HEALTH_JSON=$(curl -s --max-time 5 http://localhost:7742/health 2>/dev/null || echo "")
if [ -z "$HEALTH_JSON" ]; then
  warn "Helper did not respond. Check helper/firstpass-helper.log"
else
  ok "Helper responding on :7742"
  echo "$HEALTH_JSON" | grep -q '"whisper": *true' && ok "Transcription ready" || warn "Transcription not ready — see the log"
  echo "$HEALTH_JSON" | grep -q '"ffmpeg": *true'  && ok "ffmpeg found"        || warn "ffmpeg missing"
fi

AI_JSON=$(curl -s --max-time 5 http://localhost:7742/ai_status 2>/dev/null || echo "")
echo "$AI_JSON" | grep -q '"model": *true' && ok "AI model ready" || warn "AI model not reporting ready"

[ -n "$STARTED_FOR_CHECK" ] && pkill -f "$HERE/helper/server.py" 2>/dev/null || true

# ── 7. Manual step ──────────────────────────────────────────────────────────
cat <<DONE

${grn}${bold}Installed.${rst}

${bold}One manual step left${rst} — Adobe requires plugins be loaded by hand:

  1. ${bold}Open Premiere Pro first${rst}
  2. Install ${bold}UXP Developer Tool${rst} from Creative Cloud Desktop if you don't have it
  3. UXP Developer Tool → ${bold}Add Plugin${rst} → select:
     ${dim}$HERE/plugin/manifest.json${rst}
  4. Click ${bold}Load${rst}
  5. In Premiere:  Window → UXP Plugins → ${bold}FirstPass${rst}

Open a sequence with talking-head footage and hit ${bold}Run full cleanup${rst}.

${dim}The helper starts and stops with Premiere automatically.
Problems? Settings → Copy diagnostics, and open an issue with that text.${rst}

DONE
