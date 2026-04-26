#!/usr/bin/env bash

# RALPH - Recursive Autonomous Loop for Programming with High-level instructions
#
# Runs Claude Code in a loop, implementing one user story per iteration from prd.json.
# Each iteration gets fresh context (no memory of previous runs except via files).
#
# Usage:
#   ./ralph.sh [iterations] [pipeline-dir]
#   ./ralph.sh 10
#   ./ralph.sh 20 shared
#   ./ralph.sh 15 seo-grader

set -euo pipefail

# --- Configuration ---
SLEEP_SECONDS=2
COMPLETE_SIGNAL="<promise>COMPLETE</promise>"
ITERATIONS=${1:-10}
PIPELINE_DIR=${2:-""}

# Resolve paths based on pipeline directory
if [[ -n "$PIPELINE_DIR" ]]; then
    # Strip trailing slash
    PIPELINE_DIR="${PIPELINE_DIR%/}"
    if [[ ! -d "$PIPELINE_DIR" ]]; then
        echo "[RALPH] Error: Pipeline directory '$PIPELINE_DIR' not found." >&2
        exit 1
    fi
    PRD_FILE="${PIPELINE_DIR}/prd.json"
    PROGRESS_FILE="${PIPELINE_DIR}/progress.txt"
    LAST_BRANCH_FILE="${PIPELINE_DIR}/.ralph-last-branch"
    ARCHIVE_DIR="${PIPELINE_DIR}/.ralph-archive"
else
    PRD_FILE="prd.json"
    PROGRESS_FILE="progress.txt"
    LAST_BRANCH_FILE=".ralph-last-branch"
    ARCHIVE_DIR=".ralph-archive"
fi

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
MAGENTA='\033[0;35m'
RED='\033[0;31m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color

# --- Helpers ---
write_ralph() {
    local message=$1
    local color=${2:-$CYAN}
    echo -e "${color}[RALPH]${NC} ${message}"
}

get_branch_slug() {
    local branch_name=$1
    # Extract slug from "ralph/feature-name" -> "feature-name"
    if [[ $branch_name =~ ^ralph/(.+)$ ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo "$branch_name" | sed 's/[^a-zA-Z0-9-]/-/g'
    fi
}

archive_previous_run() {
    local old_branch=$1
    local slug=$(get_branch_slug "$old_branch")
    local datestamp=$(date +%Y-%m-%d)
    local archive_path="${ARCHIVE_DIR}/${datestamp}-${slug}"

    mkdir -p "$ARCHIVE_DIR"

    if [[ -d "$archive_path" ]]; then
        # Already archived this branch today, add a suffix
        local counter=2
        while [[ -d "${archive_path}-${counter}" ]]; do
            ((counter++))
        done
        archive_path="${archive_path}-${counter}"
    fi

    mkdir -p "$archive_path"

    [[ -f "$PRD_FILE" ]] && cp "$PRD_FILE" "$archive_path/"
    [[ -f "$PROGRESS_FILE" ]] && cp "$PROGRESS_FILE" "$archive_path/"

    write_ralph "Archived previous run ($old_branch) to $archive_path" "$YELLOW"
}

# --- Pre-flight checks ---
if ! command -v claude &> /dev/null; then
    write_ralph "Error: 'claude' CLI not found. Install Claude Code first." "$RED"
    exit 1
fi

if [[ ! -f "$PRD_FILE" ]]; then
    write_ralph "Error: $PRD_FILE not found. Run /prd or /ralph to create one." "$RED"
    exit 1
fi

# --- Read branch name from PRD ---
if ! command -v jq &> /dev/null; then
    write_ralph "Error: 'jq' not found. Install jq for JSON parsing." "$RED"
    exit 1
fi

branch_name=$(jq -r '.branchName' "$PRD_FILE")
prd_name=$(jq -r '.name' "$PRD_FILE")

if [[ -z "$branch_name" || "$branch_name" == "null" ]]; then
    write_ralph "Error: No branchName in $PRD_FILE" "$RED"
    exit 1
fi

write_ralph "Project: $prd_name" "$WHITE"
if [[ -n "$PIPELINE_DIR" ]]; then
    write_ralph "Pipeline: $PIPELINE_DIR" "$WHITE"
fi
write_ralph "Branch: $branch_name"
write_ralph "Max iterations: $ITERATIONS"

# --- Auto-archive if branch changed ---
if [[ -f "$LAST_BRANCH_FILE" ]]; then
    last_branch=$(cat "$LAST_BRANCH_FILE" | tr -d '[:space:]')
    if [[ -n "$last_branch" && "$last_branch" != "$branch_name" ]]; then
        write_ralph "Branch changed: $last_branch -> $branch_name"
        archive_previous_run "$last_branch"
    fi
fi

# Update last branch tracker
echo -n "$branch_name" > "$LAST_BRANCH_FILE"

# --- Count remaining stories ---
total=$(jq '.stories | length' "$PRD_FILE")
remaining=$(jq '[.stories[] | select(.passes != true)] | length' "$PRD_FILE")
completed=$((total - remaining))

write_ralph "Stories: ${completed}/${total} complete, ${remaining} remaining" "$WHITE"

if [[ $remaining -eq 0 ]]; then
    write_ralph "All stories already complete!" "$GREEN"
    exit 0
fi

# --- Main loop ---
STUCK_COUNT=0
MAX_STUCK=2  # Stop after 2 consecutive iterations with no progress
LAST_COMPLETED=$completed

write_ralph "Starting RALPH loop..." "$GREEN"
echo ""

for ((i=1; i<=ITERATIONS; i++)); do
    write_ralph "=== Iteration $i of $ITERATIONS ===" "$MAGENTA"

    # Run Claude Code with the RALPH prompt
    # Claude reads CLAUDE.md automatically (project instructions)
    # For pipeline dirs, tell Claude which prd.json to use
    if [[ -n "$PIPELINE_DIR" ]]; then
        prompt="Run the RALPH process. Read ${PIPELINE_DIR}/prd.json, pick the next incomplete story, implement it within the ${PIPELINE_DIR}/ directory, and follow all RALPH workflow steps in CLAUDE.md. Update ${PIPELINE_DIR}/prd.json and ${PIPELINE_DIR}/progress.txt (not root-level files). If a story is blocked by external factors (missing system packages, unavailable APIs, etc.), update its notes with the blocker, skip it, and move to the next incomplete story by priority."
    else
        prompt="Run the RALPH process. Read prd.json, pick the next incomplete story, implement it, and follow all RALPH workflow steps in CLAUDE.md. If a story is blocked by external factors (missing system packages, unavailable APIs, etc.), update its notes with the blocker, skip it, and move to the next incomplete story by priority."
    fi

    # Build allowed tools list from settings.local.json if it exists,
    # otherwise use a sensible default for autonomous operation.
    # Note: settings uses "Bash(cmd *)" but --allowedTools needs "Bash(cmd:*)"
    allowed_tools=""
    if [[ -f ".claude/settings.local.json" ]] && command -v jq &> /dev/null; then
        allowed_tools=$(jq -r '.permissions.allow // [] | join(",")' .claude/settings.local.json 2>/dev/null | sed 's/Bash(\([^ )]*\) /Bash(\1:/g')
    fi
    if [[ -z "$allowed_tools" ]]; then
        # Default permissions for RALPH autonomous operation
        allowed_tools="Read,Edit,Write,Glob,Grep,Bash(git:*),Bash(python:*),Bash(python3:*),Bash(pip:*),Bash(pip3:*),Bash(pytest:*),Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(cargo:*),Bash(go:*),Bash(ls:*),Bash(mkdir:*),Bash(cp:*),Bash(mv:*),Bash(cat:*),Bash(echo:*),Bash(which:*),Bash(source:*),Bash(chmod:*),Bash(rm:*),Bash(touch:*),Bash(find:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Bash(sort:*),Bash(grep:*),Bash(sed:*),Bash(awk:*),Bash(curl:*),Bash(jq:*),Bash(diff:*)"
    fi

    # Capture output (pipe prompt via stdin so --allowedTools doesn't consume it)
    output=$(echo "$prompt" | claude --print --allowedTools $allowed_tools 2>&1 | tee /dev/tty)

    # Check for completion signal — but verify against PRD ground truth
    # (The signal can appear in explanatory text, so also check the actual PRD)
    if echo "$output" | grep -qF "$COMPLETE_SIGNAL"; then
        actual_remaining=$(jq '[.stories[] | select(.passes != true)] | length' "$PRD_FILE" 2>/dev/null || echo "1")
        if [[ "$actual_remaining" -eq 0 ]]; then
            echo ""
            write_ralph "ALL STORIES COMPLETE!" "$GREEN"
            write_ralph "Total iterations used: $i"
            break
        else
            write_ralph "Completion signal found but $actual_remaining stories remain — continuing..." "$YELLOW"
        fi
    fi

    # Re-read PRD to check progress
    if [[ -f "$PRD_FILE" ]]; then
        remaining=$(jq '[.stories[] | select(.passes != true)] | length' "$PRD_FILE")
        completed=$((total - remaining))
        write_ralph "Progress: ${completed}/${total} stories complete" "$WHITE"

        if [[ $remaining -eq 0 ]]; then
            write_ralph "ALL STORIES COMPLETE!" "$GREEN"
            break
        fi
    fi

    if [[ $i -lt $ITERATIONS ]]; then
        write_ralph "Sleeping ${SLEEP_SECONDS}s before next iteration..."
        sleep $SLEEP_SECONDS
    fi
done

echo ""
write_ralph "RALPH loop finished after $i iteration(s)." "$CYAN"

# Final summary
if [[ -f "$PRD_FILE" ]]; then
    remaining=$(jq '[.stories[] | select(.passes != true)] | length' "$PRD_FILE")
    completed=$((total - remaining))
    if [[ $remaining -gt 0 ]]; then
        write_ralph "Status: ${completed}/${total} complete. ${remaining} stories remaining." "$YELLOW"
    else
        write_ralph "Status: All ${total} stories complete!" "$GREEN"
    fi
fi
