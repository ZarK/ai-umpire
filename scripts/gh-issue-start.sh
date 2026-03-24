#!/usr/bin/env bash

# Start work on a GitHub issue
# - Verifies issue is not blocked
# - Adds a start comment

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/_queue-policy.sh"

if [ $# -eq 0 ]; then
	echo "Usage: $0 <issue_number> [--force]"
	echo ""
	echo "Starts work on an issue by:"
	echo "  1. Checking if issue is blocked (fails if blocked, unless --force)"
	echo "  2. Setting status to ${QUEUE_IN_PROGRESS_STATUS}"
	echo "  3. Adding a start comment"
	echo ""
	echo "Options:"
	echo "  --force    Start even if issue is marked ${QUEUE_BLOCKED_STATUS}"
	echo ""
	echo "Example:"
	echo "  $0 85"
	echo "  $0 85 --force"
	exit 1
fi

ISSUE_NUM=$1
FORCE=false

if [ "${2:-}" = "--force" ]; then
	FORCE=true
fi

# Check if issue exists and get current state
echo "🔍 Checking issue #$ISSUE_NUM..."

if ! issue_data=$(gh issue view "$ISSUE_NUM" --json number,title,state,labels,body 2>/dev/null); then
	echo "❌ Issue #$ISSUE_NUM not found"
	exit 1
fi

issue_state=$(echo "$issue_data" | jq -r '.state')
issue_title=$(echo "$issue_data" | jq -r '.title')
labels=$(echo "$issue_data" | jq -r '.labels[].name')

# Check if already closed
if [ "$issue_state" = "CLOSED" ]; then
	echo "❌ Issue #$ISSUE_NUM is already closed"
	exit 1
fi

# Check if blocked
if printf '%s\n' "$labels" | grep -Fxq "$QUEUE_BLOCKED_STATUS"; then
	if [ "$FORCE" = false ]; then
		echo "🚫 Issue #$ISSUE_NUM is blocked!"
		echo ""
		echo "Check blockers with: ./scripts/gh-issue-deps.sh $ISSUE_NUM"
		echo "Or use --force to start anyway"
		exit 1
	else
		echo "⚠️  Starting blocked issue (--force used)"
	fi
fi

# Check if already in progress
if printf '%s\n' "$labels" | grep -Fxq "$QUEUE_IN_PROGRESS_STATUS"; then
	echo "ℹ️  Issue #$ISSUE_NUM is already in progress"
	exit 0
fi

# Check for other in-progress issues
in_progress=$(gh issue list --label "$QUEUE_IN_PROGRESS_STATUS" --state open --json number,title --jq '.[] | "#\(.number): \(.title)"' 2>/dev/null)
if [ -n "$in_progress" ]; then
	echo "⚠️  Other issues are currently in progress:"
	echo "$in_progress"
	echo ""
	read -p "Continue starting #$ISSUE_NUM anyway? (y/N) " -n 1 -r
	echo
	if [[ ! $REPLY =~ ^[Yy]$ ]]; then
		echo "Cancelled."
		exit 1
	fi
fi

# Update labels
echo "📝 Setting ${QUEUE_IN_PROGRESS_STATUS}..."
gh issue edit "$ISSUE_NUM" --remove-label "$(queue_transition_remove_csv start)" 2>/dev/null || true
gh issue edit "$ISSUE_NUM" --add-label "$(queue_transition_add_label start)"

# Add start comment
echo "💬 Adding start comment..."
gh issue comment "$ISSUE_NUM" --body "🚀 **Started work on this issue**

Working on: $issue_title

Will update checkboxes as progress is made."

echo ""
echo "✅ Started issue #$ISSUE_NUM: $issue_title"
echo ""
echo "Next steps:"
echo "  1. Implement the changes"
echo "  2. Commit with: #$ISSUE_NUM <type>: <summary>"
echo "  3. Push after each commit"
echo "  4. Update issue checkboxes"
echo "  5. When done: ./scripts/gh-issue-complete.sh $ISSUE_NUM"
