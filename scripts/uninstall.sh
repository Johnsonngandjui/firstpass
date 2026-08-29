#!/usr/bin/env bash
# FirstPass uninstaller — removes everything the installer created: the watcher,
# the virtualenv, the speech model and the language model. Safe to re-run.
#
#   scripts/uninstall.sh                 remove everything (asks first)
#   scripts/uninstall.sh -y              don't ask
#   scripts/uninstall.sh --keep-models   keep the ~12 GB of downloads, remove the rest
set -euo pipefail

# scripts/ is one level down; HERE is the repo root, which is what the venv and
# the markers hang off, and what gets removed at the end.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$HERE/helper/firstpass-env"
PLIST="$HOME/Library/LaunchAgents/com.firstpass.helper.plist"
AGENT="gui/$(id -u)/com.firstpass.helper"
OLLAMA_MODEL="qwen2.5:14b-instruct"
WHISPER_DIR="${HF_HOME:-$HOME/.cache/huggingface}/hub/models--nyralabs--CrisperWhisper2.0_large"
PLUGIN_STORE="$HOME/Library/Application Support/Adobe/UXP/PluginsStorage"

ASSUME_YES=""
KEEP_MODELS=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes)      ASSUME_YES=1 ;;
    --keep-models) KEEP_MODELS=1 ;;
    -h|--help)     sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             echo "Unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

bold=$(tput bold 2>/dev/null || true); dim=$(tput dim 2>/dev/null || true)
grn=$(tput setaf 2 2>/dev/null || true); ylw=$(tput setaf 3 2>/dev/null || true)
rst=$(tput sgr0 2>/dev/null || true)

step() { echo; echo "${bold}▸ $*${rst}"; }
ok()   { echo "  ${grn}✓${rst} $*"; }
warn() { echo "  ${ylw}!${rst} $*"; }
skip() { echo "  ${dim}· $*${rst}"; }

# Same ollama discovery as premiere-watch.sh — it may not be on a login PATH.
find_ollama() {
  command -v ollama 2>/dev/null && return 0
  for p in /opt/homebrew/bin/ollama /usr/local/bin/ollama \
           /opt/homebrew/opt/ollama/bin/ollama /Applications/Ollama.app/Contents/Resources/ollama; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}
OLLAMA="$(find_ollama || true)"

size_of() { du -sh "$1" 2>/dev/null | awk '{print $1}'; }

# ── What's actually here ────────────────────────────────────────────────────
echo
echo "${bold}FirstPass uninstaller${rst}"
echo "${dim}This removes what the installer created. Your footage and projects are untouched.${rst}"

step "Found"
FOUND=""
[ -d "$VENV" ]     && { ok "Virtualenv           $(size_of "$VENV")"; FOUND=1; }
[ -f "$PLIST" ]    && { ok "Background watcher"; FOUND=1; }
if [ -z "$KEEP_MODELS" ]; then
  [ -d "$WHISPER_DIR" ] && { ok "Speech model         $(size_of "$WHISPER_DIR")"; FOUND=1; }
  if [ -n "$OLLAMA" ] && "$OLLAMA" list 2>/dev/null | grep -qF "$OLLAMA_MODEL"; then
    ok "Language model       $OLLAMA_MODEL (~9 GB)"; FOUND=1
  fi
else
  skip "Keeping the speech and language models (--keep-models)"
fi

if [ -z "$FOUND" ]; then
  echo
  echo "  Nothing to remove — FirstPass isn't installed here."
  echo
  exit 0
fi

if [ -z "$ASSUME_YES" ]; then
  if [ ! -t 0 ]; then
    echo
    echo "  Not running interactively — re-run with -y to confirm."
    exit 1
  fi
  echo
  printf "  ${bold}Remove these? [y/N]${rst} "
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo; echo "  Cancelled. Nothing was removed."; echo; exit 0 ;;
  esac
fi

# ── 1. Stop the watcher and the helper ──────────────────────────────────────
step "Stopping the helper"

launchctl bootout "$AGENT" 2>/dev/null || true
# bootout is asynchronous; give it a moment before we start deleting the files
# the watcher is still reading.
for _ in $(seq 1 15); do
  launchctl print "$AGENT" >/dev/null 2>&1 || break
  sleep 1
done

# The watcher stops its own server via a TERM trap, but kill both directly in
# case it was started by hand. Both are matched by absolute path, the way
# premiere-watch.sh does it.
pkill -f "$HERE/helper/premiere-watch.sh" 2>/dev/null || true
pkill -f "$HERE/helper/server.py" 2>/dev/null || true
sleep 1

if launchctl print "$AGENT" >/dev/null 2>&1; then
  warn "The LaunchAgent is still registered — try again after quitting Premiere"
else
  ok "Watcher stopped and unregistered"
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  ok "Removed $PLIST"
fi

# ── 2. Virtualenv ───────────────────────────────────────────────────────────
step "Removing the Python helper"

if [ -d "$VENV" ]; then
  rm -rf "$VENV"
  ok "Removed the virtualenv"
else
  skip "No virtualenv"
fi

rm -rf "$HERE/helper/__pycache__"
rm -f "$HERE"/helper/firstpass-helper.log "$HERE"/helper/firstpass-helper.log.1 \
      "$HERE/helper/firstpass_state.json" "$HERE/helper/firstpass_debug.json"
ok "Removed logs, cached bytecode and saved state"

# ── 3. Models ───────────────────────────────────────────────────────────────
if [ -z "$KEEP_MODELS" ]; then
  step "Removing the models"

  if [ -d "$WHISPER_DIR" ]; then
    rm -rf "$WHISPER_DIR"
    ok "Removed the speech model"
  else
    skip "Speech model not in the cache"
  fi

  if [ -n "$OLLAMA" ] && "$OLLAMA" list 2>/dev/null | grep -qF "$OLLAMA_MODEL"; then
    # Needs the daemon up; if it isn't, say so rather than failing silently.
    if curl -s --max-time 2 http://localhost:11434/api/version >/dev/null 2>&1; then
      "$OLLAMA" rm "$OLLAMA_MODEL" >/dev/null 2>&1 \
        && ok "Removed $OLLAMA_MODEL" \
        || warn "Could not remove $OLLAMA_MODEL — try: ollama rm $OLLAMA_MODEL"
    else
      warn "Ollama isn't running, so its model is still on disk. Start it and run:
      ollama rm $OLLAMA_MODEL"
    fi
  else
    skip "Language model not installed"
  fi
fi

# ── 4. Things FirstPass installed for itself ────────────────────────────────
# install.sh drops a marker whenever it installs something the machine didn't
# already have, so this only removes what we brought with us. Without the
# marker we leave it alone — it was here first.
OLLAMA_MARKER="$HERE/helper/.ollama-installed-by-firstpass"
UV_MARKER="$HERE/helper/.uv-installed-by-firstpass"

if [ -f "$OLLAMA_MARKER" ] || [ -f "$UV_MARKER" ]; then
  step "Removing what FirstPass installed for itself"

  if [ -f "$UV_MARKER" ]; then
    # ~/.local/bin/env is left alone on purpose: several unrelated installers
    # write a file by that name, and it's a two-line PATH snippet either way.
    rm -rf "$HOME/.local/bin/uv" "$HOME/.local/bin/uvx" "$HOME/.local/share/uv"
    rm -f "$UV_MARKER"
    ok "Removed uv and the private Python it fetched"
  fi

  if [ -f "$OLLAMA_MARKER" ]; then
    # Only if nothing else is left in it. The user may have pulled their own
    # models since, and those aren't ours to delete.
    REMAINING=0
    if [ -n "$OLLAMA" ] && curl -s --max-time 2 http://localhost:11434/api/version >/dev/null 2>&1; then
      REMAINING="$("$OLLAMA" list 2>/dev/null | tail -n +2 | grep -c . || true)"
    fi
    if [ "${REMAINING:-0}" -gt 0 ]; then
      warn "Leaving Ollama installed — it still holds $REMAINING other model(s)"
    else
      pkill -f "Ollama.app" 2>/dev/null || true
      rm -rf /Applications/Ollama.app "$HOME/.ollama"
      rm -f "$OLLAMA_MARKER"
      ok "Removed Ollama, which FirstPass installed"
    fi
  fi
fi

# ── 5. Premiere's copy of the panel ─────────────────────────────────────────
step "Removing the panel's stored data"

REMOVED_PANEL=""
if [ -d "$PLUGIN_STORE" ]; then
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    rm -rf "$d"
    REMOVED_PANEL=1
  done < <(find "$PLUGIN_STORE" -maxdepth 4 -type d -name "com.firstpass.panel" 2>/dev/null)
fi
[ -n "$REMOVED_PANEL" ] && ok "Removed Premiere's stored plugin data" \
                        || skip "Nothing stored by Premiere"

# ── 6. What's left for you ──────────────────────────────────────────────────
# Only mention removing Ollama if it's still here — if FirstPass installed it,
# section 4 already took it away.
OLLAMA_NOTE=""
if [ -n "$(find_ollama || true)" ]; then
  OLLAMA_NOTE="
${dim}Ollama itself was left installed — other tools may be using it.
If nothing else needs it:  brew uninstall ollama${rst}"
fi

cat <<DONE

${grn}${bold}Uninstalled.${rst}

${bold}Two things this can't do for you${rst}:

  1. Remove the panel from ${bold}UXP Developer Tool${rst} — open it and click
     Remove on FirstPass. Adobe gives no way to script this.
  2. Delete this folder, if you want the source gone too:
     ${dim}rm -rf "$HERE"${rst}
$OLLAMA_NOTE

DONE
