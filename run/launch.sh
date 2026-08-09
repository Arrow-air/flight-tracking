#!/bin/zsh
# First launch of the flight-tracking P0 overnight run.
# Run ONLY on Thomas's go. Does: branch checkout → host launch → verify the
# workflow actually started → record RUNID → start watchdog.
set -e
REPO="/Users/hex/projects/arrow/flight-tracking"
SCRIPT="$REPO/run-workflow.js"
RESULT="$REPO/RUN-RESULT.md"
MARKER="headless host process for the flight-tracking P0 workflow"

if [ -f "$RESULT" ]; then echo "RUN-RESULT.md already exists — refusing"; exit 1; fi
if pgrep -f "$MARKER" >/dev/null; then echo "host already running — refusing"; exit 1; fi

cd "$REPO"
git diff --quiet || { echo "working tree dirty — commit/stash first"; exit 1; }
git rev-parse --verify overnight/p0 >/dev/null 2>&1 || git branch overnight/p0
git checkout overnight/p0

LAUNCH_TS=$(date +%s)
CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 nohup caffeinate -i claude -p --dangerously-skip-permissions --model claude-fable-5 "You are a headless host process for the flight-tracking P0 workflow. Your ONLY job: (1) Invoke the Workflow tool with exactly {\"scriptPath\": \"$SCRIPT\"}. (2) Stay alive waiting for the workflow completion notification — do not exit, do not do other work, do not edit files in $REPO (the workflow agents own them). (3) When the workflow completes: write its return value and a phase-by-phase summary to $RESULT. Do not commit, do not push (the workflow's packager agent commits). If the Workflow tool errors on invocation, relaunch it ONCE passing resumeFromRunId from the error/result; if it fails twice, write the error to $RESULT and stop." > /tmp/ft-p0-host-L0.log 2>&1 &
HOSTPID=$!
echo "host launched pid $HOSTPID — waiting 120s to verify the workflow started"
sleep 120

JOURNAL=$(find ~/.claude/projects -path "*workflows/wf_*" -name journal.jsonl -newermt "@$LAUNCH_TS" 2>/dev/null | head -1)
if [ -z "$JOURNAL" ]; then
  echo "NO journal found — workflow did not start. Check /tmp/ft-p0-host-L0.log"; exit 1
fi
RUNID=$(basename $(dirname "$JOURNAL"))
echo "$RUNID" > "$REPO/run/RUNID"
echo "workflow running: $RUNID ($JOURNAL)"

nohup zsh "$REPO/run/watchdog.sh" > /dev/null 2>&1 &
echo "watchdog started pid $!"
echo "monitor: tail -f /tmp/ft-p0-watchdog.log ; journal: wc -l $JOURNAL"
