#!/bin/bash
# FirstPass helper watcher — runs the Python server ONLY while Premiere is open,
# so transcription/LLM processes aren't holding RAM while you're not editing.
# Started by the LaunchAgent com.firstpass.helper at login; itself is tiny.

# All paths derive from this script's own location, so the repo can live
# anywhere the user cloned it.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="$HERE"
SERVER="$HERE/server.py"
LOG="$HERE/firstpass-helper.log"
HEALTH="http://localhost:7742/health"
# venv always creates bin/python3 regardless of the minor version it was built against
PY="$HERE/firstpass-env/bin/python3"
# Match the server by its script path — the venv python is a symlink, so the
# process shows the RESOLVED interpreter path, not firstpass-env/… .
SERVER_TAG="$SERVER"

# Local LLM backend for AI Flow / AI Edit (idle-light: it unloads the model after
# a few minutes of no use, so we just make sure the daemon is up).
find_ollama() {
  command -v ollama 2>/dev/null && return 0
  for p in /opt/homebrew/bin/ollama /usr/local/bin/ollama \
           /opt/homebrew/opt/ollama/bin/ollama /Applications/Ollama.app/Contents/Resources/ollama; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}
OLLAMA="$(find_ollama)"

# Keep the log from growing without bound across months of daily use.
rotate_log() {
  [ -f "$LOG" ] || return 0
  local size
  size=$(wc -c <"$LOG" 2>/dev/null || echo 0)
  [ "$size" -gt 5242880 ] && mv -f "$LOG" "$LOG.1"   # 5 MB → keep one previous
  return 0
}

ollama_up()    { curl -s --max-time 2 http://localhost:11434/api/version >/dev/null 2>&1; }
start_ollama() { ollama_up && return 0; [ -n "$OLLAMA" ] && [ -x "$OLLAMA" ] || return 0; nohup "$OLLAMA" serve >>"$LOG" 2>&1 & }

premiere_running() {
  # -f matches the full command line, so this keeps working for future year
  # versions (…/Adobe Premiere Pro 2027.app/Contents/MacOS/…) without an edit.
  pgrep -f "Adobe Premiere Pro [0-9]{4}" >/dev/null 2>&1 && return 0
  pgrep -f "Adobe Premiere Pro \(Beta\)"  >/dev/null 2>&1 && return 0
  return 1
}
server_up()  { curl -s --max-time 2 "$HEALTH" >/dev/null 2>&1; }

start_server() {
  # already up, or still booting (process exists but health not ready) → don't double-start
  server_up && return 0
  pgrep -f "$SERVER_TAG" >/dev/null 2>&1 && return 0
  [ -x "$PY" ] || { echo "[$(date '+%F %T')] missing venv at $PY — run ./install.sh" >>"$LOG"; return 1; }
  cd "$WORKDIR" || return 1
  rotate_log
  echo "[$(date '+%F %T')] Premiere open → starting helper" >>"$LOG"
  "$PY" "$SERVER" >>"$LOG" 2>&1 &
}
stop_server() {
  pgrep -f "$SERVER_TAG" >/dev/null 2>&1 || return 0
  echo "[$(date '+%F %T')] Premiere closed → stopping helper" >>"$LOG"
  pkill -f "$SERVER_TAG" 2>/dev/null
}

# If the watcher itself is stopped (launchctl bootout / logout), take the server down too.
trap 'stop_server; exit 0' TERM INT

while true; do
  if premiere_running; then
    ollama_up || start_ollama       # AI Flow / AI Edit backend
    server_up || start_server       # transcription / cut helper
  else
    stop_server                     # leave Ollama alone (it self-unloads its model)
  fi
  sleep 5
done
