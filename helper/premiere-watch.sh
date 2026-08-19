#!/bin/bash
# ClipCutter helper watcher — runs the Python server ONLY while Premiere is open.
# Started by the LaunchAgent com.clipcutter.helper at login; itself is tiny.

PY="/Users/johnsonngandjui/Workspace/clipcutter/helper/clipcutter-env/bin/python3.11"
SERVER="/Users/johnsonngandjui/Workspace/clipcutter/helper/server.py"
WORKDIR="/Users/johnsonngandjui/Workspace/clipcutter/helper"
LOG="/Users/johnsonngandjui/Workspace/clipcutter/helper/clipcutter-helper.log"
HEALTH="http://localhost:7742/health"
# Match the server by its script path — the venv python is a symlink, so the
# process shows the RESOLVED interpreter path, not clipcutter-env/… .
SERVER_TAG="/Users/johnsonngandjui/Workspace/clipcutter/helper/server.py"

premiere_running() {
  pgrep -x "Adobe Premiere Pro 2026" >/dev/null 2>&1 && return 0
  pgrep -x "Adobe Premiere Pro \(Beta\)" >/dev/null 2>&1 && return 0
  return 1
}
server_up()  { curl -s --max-time 2 "$HEALTH" >/dev/null 2>&1; }

start_server() {
  # already up, or still booting (process exists but health not ready) → don't double-start
  server_up && return 0
  pgrep -f "$SERVER_TAG" >/dev/null 2>&1 && return 0
  cd "$WORKDIR" || return 1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Premiere open → starting helper" >>"$LOG"
  "$PY" "$SERVER" >>"$LOG" 2>&1 &
}
stop_server() {
  pgrep -f "$SERVER_TAG" >/dev/null 2>&1 || return 0
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Premiere closed → stopping helper" >>"$LOG"
  pkill -f "$SERVER_TAG" 2>/dev/null
}

# If the watcher itself is stopped (launchctl bootout / logout), take the server down too.
trap 'stop_server; exit 0' TERM INT

while true; do
  if premiere_running; then
    server_up || start_server
  else
    stop_server
  fi
  sleep 5
done
