#!/usr/bin/env bash
set -euo pipefail

# Smart GitHub Issues Priority Ordering
# Creates a clean, dependency-aware prioritized work list

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/_queue-policy.sh"

json_mode=false
show_help=false

for arg in "$@"; do
	case "$arg" in
	"--json") json_mode=true ;;
	"--help" | "-h") show_help=true ;;
	esac
done

# Get all open issues with their labels (limit 100 to get all)
priority_labels_json="$(queue_priority_labels_json)"
status_labels_json="$(queue_status_labels_json)"
issues_data=$(gh issue list --state open --limit 100 --json number,title,labels | jq \
	--arg componentPrefix "$QUEUE_COMPONENT_PREFIX" \
	--arg defaultPriority "$QUEUE_DEFAULT_PRIORITY" \
	--arg defaultStatus "$QUEUE_DEFAULT_STATUS" \
	--argjson priorityLabels "$priority_labels_json" \
	--argjson statusLabels "$status_labels_json" \
	'map({
	  number: .number,
	  title: .title,
	  priority: ((.labels | map(.name) | map(select(. as $label | $priorityLabels | index($label))) | .[0]) // $defaultPriority),
	  status: ((.labels | map(.name) | map(select(. as $label | $statusLabels | index($label))) | .[0]) // $defaultStatus),
	  component: (.labels | map(.name) | map(select(startswith($componentPrefix))) | .[0] // ""),
	  labels: [.labels[]?.name]
	})')

# Function to get priority score for sorting
get_priority_score() {
	local priority="$1"
	local status="$2"
	local base_score
	local status_modifier

	base_score="$(queue_priority_score "$priority")"
	status_modifier="$(queue_status_modifier "$status")"

	echo $((base_score + status_modifier))
}

build_ordered_issues_json() {
	while IFS=$'\t' read -r score priority status component number title; do
		jq -nc \
			--argjson score "$score" \
			--arg priority "$priority" \
			--arg status "$status" \
			--arg component "$component" \
			--argjson number "$number" \
			--arg title "$title" \
			'{
				component: (if $component == "__NONE__" then "" else $component end),
				labels: ([$priority] + (if $component == "__NONE__" then [] else [$component] end) + [$status]),
				number: $number,
				priority: $priority,
				score: $score,
				status: $status,
				title: $title
			}'
	done < <(
		while IFS=$'\t' read -r priority status component number title; do
			score=$(get_priority_score "$priority" "$status")
			printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$score" "$priority" "$status" "$component" "$number" "$title"
		done < <(
			echo "$issues_data" | jq -r --arg defaultPriority "$QUEUE_DEFAULT_PRIORITY" --arg defaultStatus "$QUEUE_DEFAULT_STATUS" '.[] | [(.priority // $defaultPriority), (.status // $defaultStatus), ((.component // "") | if . == "" then "__NONE__" else . end), (.number | tostring), .title] | @tsv'
		) | sort -t$'\t' -k1,1nr -k2,2 -k3,3r -k5,5n
	) | jq -s '.'
}

ordered_issues_json=$(build_ordered_issues_json)
ready_issues_json=$(printf '%s\n' "$ordered_issues_json" | jq --arg readyStatus "$QUEUE_READY_STATUS" '[.[] | select(.status == $readyStatus) | .number]')
blocked_issues_json=$(printf '%s\n' "$ordered_issues_json" | jq --arg blockedStatus "$QUEUE_BLOCKED_STATUS" '[.[] | select(.status == $blockedStatus) | .number]')
next_issue_json=$(printf '%s\n' "$ordered_issues_json" | jq --arg blockedStatus "$QUEUE_BLOCKED_STATUS" --arg inProgressStatus "$QUEUE_IN_PROGRESS_STATUS" '([.[] | select(.status != $inProgressStatus and .status != $blockedStatus) | .number] | .[0]) // null')
in_progress_json=$(printf '%s\n' "$ordered_issues_json" | jq --arg inProgressStatus "$QUEUE_IN_PROGRESS_STATUS" '[.[] | select(.status == $inProgressStatus) | .number]')

if [ "$json_mode" = true ]; then
	jq -n \
		--argjson blockedIssues "$blocked_issues_json" \
		--argjson inProgress "$in_progress_json" \
		--argjson issues "$ordered_issues_json" \
		--argjson nextIssue "$next_issue_json" \
		--argjson readyIssues "$ready_issues_json" \
		'{
			version: 1,
			issues: $issues,
			readyIssues: $readyIssues,
			nextIssue: $nextIssue,
			blockedIssues: $blockedIssues,
			inProgress: $inProgress
		}'
	exit 0
fi

echo "🎯 PRIORITY ORDER (Next → Last)"
echo "================================="

# Create prioritized list
counter=1

while IFS=$'\t' read -r priority status component number title; do
	if [ "$component" = "__NONE__" ]; then
		component=""
	fi

	labels="[$priority"
	if [ "$component" != "" ]; then
		labels="$labels, $component"
	fi
	labels="$labels, $status]"

	echo "$counter. #$number: $title $labels"
	((counter++))
done < <(
	printf '%s\n' "$ordered_issues_json" | jq -r '.[] | [.priority, .status, ((.component // "") | if . == "" then "__NONE__" else . end), (.number | tostring), .title] | @tsv'
)

echo ""

# Show recommendations
next_issue=$(printf '%s\n' "$next_issue_json" | jq -r 'if . == null then "" else "#\(.)" end')
if [ -n "$next_issue" ]; then
	echo "💡 Next recommended work: $next_issue (ready to start)"
fi

# Show blocked issues
blocked_issues=$(printf '%s\n' "$blocked_issues_json" | jq -r 'map("#\(.)") | join(" ")')
if [ -n "$blocked_issues" ]; then
	echo "🚫 Blocked issues: $blocked_issues (resolve dependencies first)"
fi

# Show in progress
in_progress=$(printf '%s\n' "$in_progress_json" | jq -r 'map("#\(.)") | join(" ")')
if [ -n "$in_progress" ]; then
	echo "🔄 Currently in progress: $in_progress"
fi

echo ""
echo "Commands:"
echo "  gh issue view <number>                    - View issue details"
echo "  ./scripts/gh-update-labels.sh <number>   - Update issue labels"
echo "  ./scripts/gh-priority-order.sh --json    - Show structured queue data"
echo "  ./scripts/gh-priority-order.sh --help    - Show labeling guide"

# Show help if requested
if [ "$show_help" = true ]; then
	echo ""
	echo "LABELING SYSTEM GUIDE"
	echo "===================="
	echo ""
	echo "Priority Labels (P):"
	queue_print_priority_help
	echo ""
	echo "Status Labels (S):"
	queue_print_status_help
	echo ""
	echo "Component Labels (C):"
	queue_print_component_help
	echo ""
	echo "Quick Commands:"
	echo "  ./scripts/gh-update-labels.sh 14 start      # Mark as in progress"
	echo "  ./scripts/gh-update-labels.sh 14 ready      # Mark as ready"
	echo "  ./scripts/gh-update-labels.sh 14 block      # Mark as blocked"
	echo "  ./scripts/gh-priority-order.sh --json       # Print machine-readable queue data"
	echo "  ./scripts/gh-update-labels.sh 14 priority ${QUEUE_PRIORITY_NAMES[1]}"
	if queue_has_component_taxonomy; then
		echo "  ./scripts/gh-update-labels.sh 14 component ${QUEUE_COMPONENT_NAMES[0]}"
	fi
fi
