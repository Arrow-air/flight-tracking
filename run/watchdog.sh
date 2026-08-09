#!/bin/zsh
# Watchdog for the flight-tracking P0 overnight workflow host.
# Adapted from quiver-dock rev2 (limit-aware). Reads RUNID from run/RUNID
# (written by launch.sh after the first host launch is verified).
# Exits when RUN-RESULT.md appears.
REPO="/Users/hex/projects/arrow/flight-tracking"
RUNID="$(cat $REPO/run/RUNID 2>/dev/null)"
SCRIPT="$REPO/run-workflow.js"
RESULT="$REPO/RUN-RESULT.md"
LOG="/tmp/ft-p0-watchdog.log"
MARKER="headless host process for the flight-tracking P0 workflow"
RESTARTS=0
MAX_RESTARTS=5
LAUNCHES=0
LAST_LOG=""

if [ -z "$RUNID" ]; then
  echo "$(date) no RUNID file — run launch.sh first" >> "$LOG"
  exit 1
fi

echo "$(date) watchdog up (pid $$), resume id $RUNID" >> "$LOG"
while true; do
  if [ -f "$RESULT" ]; then
    echo "$(date) RUN-RESULT.md present — run complete, watchdog exiting" >> "$LOG"
    exit 0
  fi
  if ! pgrep -f "$MARKER" >/dev/null 2>&1; then
    if [ -n "$LAST_LOG" ] && grep -q "hit your session limit" "$LAST_LOG" 2>/dev/null; then
      echo "$(date) host died on session limit — waiting 15 min, not counting a restart" >> "$LOG"
      sleep 900
    elif [ "$RESTARTS" -ge "$MAX_RESTARTS" ]; then
      echo "$(date) host dead and restart budget exhausted ($MAX_RESTARTS) — giving up" >> "$LOG"
      exit 1
    else
      RESTARTS=$((RESTARTS+1))
    fi
    LAUNCHES=$((LAUNCHES+1))
    LAST_LOG="/tmp/ft-p0-host-L$LAUNCHES.log"
    echo "$(date) relaunching host — launch #$LAUNCHES (restart count $RESTARTS/$MAX_RESTARTS, resume $RUNID)" >> "$LOG"
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 nohup caffeinate -i claude -p --dangerously-skip-permissions --model claude-fable-5 "You are a headless host process for the flight-tracking P0 workflow. Your ONLY job: (1) Invoke the Workflow tool with exactly {\"scriptPath\": \"$SCRIPT\", \"resumeFromRunId\": \"$RUNID\"} — the resume returns cached results for already-completed agents. (2) Stay alive waiting for the workflow completion notification — do not exit, do not do other work, do not edit files in $REPO (the workflow agents own them). (3) When the workflow completes: write its return value and a phase-by-phase summary to $RESULT. Do not commit, do not push (the workflow's packager agent commits). If the Workflow tool errors on invocation, report the error as your final message and exit." > "$LAST_LOG" 2>&1 &
    echo "$(date) relaunched as pid $!" >> "$LOG"
    sleep 90
  fi
  sleep 60
done
