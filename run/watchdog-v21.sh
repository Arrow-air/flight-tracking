#!/bin/zsh
# Watchdog for the quiver-dock overnight workflow host.
# If the headless claude host dies, relaunch it with resumeFromRunId so
# completed agents come back from cache. Exits when RUN-RESULT.md appears.
RUNID="wf_6a3697d5-314"
SCRIPT="/Users/hex/projects/arrow/flight-tracking/run-workflow-v21.js"
RESULT="/Users/hex/projects/arrow/flight-tracking/run/RUN-RESULT-V21.md"
LOG="/tmp/ft-v21-watchdog.log"
MARKER="headless host process for a long-running background workflow"
RESTARTS=0
MAX_RESTARTS=5

echo "$(date) watchdog up (pid $$), watching for '$MARKER'" >> "$LOG"
while true; do
  if [ -f "$RESULT" ]; then
    echo "$(date) RUN-RESULT.md present — run complete, watchdog exiting" >> "$LOG"
    exit 0
  fi
  if ! pgrep -f "$MARKER" >/dev/null 2>&1; then
    if [ "$RESTARTS" -ge "$MAX_RESTARTS" ]; then
      echo "$(date) host dead and restart budget exhausted ($MAX_RESTARTS) — giving up" >> "$LOG"
      exit 1
    fi
    RESTARTS=$((RESTARTS+1))
    echo "$(date) host dead — restart #$RESTARTS (resume $RUNID)" >> "$LOG"
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 nohup caffeinate -i claude -p --dangerously-skip-permissions --model claude-fable-5 "You are a headless host process for a long-running background workflow. Your ONLY job: (1) Invoke the Workflow tool with exactly {\"scriptPath\": \"$SCRIPT\", \"resumeFromRunId\": \"$RUNID\"} — the resume returns cached results for already-completed agents. (2) Stay alive waiting for the workflow completion notification — do not exit, do not do other work, do not edit files in /Users/hex/projects/arrow/flight-tracking (the workflow agents own them). (3) When the workflow completes: write its return value and a phase-by-phase summary to $RESULT, then run git -C /Users/hex/projects/arrow/flight-tracking add -A and commit with message 'Overnight run outputs (detached host, fable)'. If the Workflow tool errors on invocation, report the error as your final message and exit." > "/tmp/ft-v21-host-r$RESTARTS.log" 2>&1 &
    echo "$(date) relaunched as pid $!" >> "$LOG"
    sleep 90  # give it time to boot before re-checking
  fi
  sleep 60
done
