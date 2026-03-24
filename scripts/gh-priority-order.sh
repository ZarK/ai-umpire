#!/bin/bash

# Smart GitHub Issues Priority Ordering
# Creates a clean, dependency-aware prioritized work list

echo "🎯 PRIORITY ORDER (Next → Last)"
echo "================================="

# Get all open issues with their labels (limit 100 to get all)
issues_data=$(gh issue list --state open --limit 100 --json number,title,labels --jq '
  map({
    number: .number,
    title: .title,
    priority: (.labels | map(select(.name | startswith("P"))) | .[0].name // "P3-Medium"),
    status: (.labels | map(select(.name | startswith("S"))) | .[0].name // "S-Ready"), 
    component: (.labels | map(select(.name | startswith("C"))) | .[0].name // ""),
    labels: [.labels[]?.name]
  })
')

# Function to get priority score for sorting
get_priority_score() {
	local priority="$1"
	local status="$2"
	local base_score
	local status_modifier

	# Base priority scores
	case "$priority" in
	"P1-Critical") base_score=1000 ;;
	"P2-High") base_score=500 ;;
	"P3-Medium") base_score=100 ;;
	"P4-Low") base_score=10 ;;
	*) base_score=50 ;; # Default for unlabeled
	esac

	# Status modifiers
	case "$status" in
	"S-Blocking") status_modifier=200 ;;
	"S-Ready") status_modifier=50 ;;
	"S-InProgress") status_modifier=25 ;;
	"S-Blocked") status_modifier=-100 ;;
	*) status_modifier=0 ;;
	esac

	echo $((base_score + status_modifier))
}

# Create prioritized list
counter=1
next_issue=""
blocked_issues=()

# Process issues by priority order
	while IFS=$'\t' read -r score priority status component number title; do
		if [ "$component" = "__NONE__" ]; then
			component=""
		fi

		# Build label display
		labels="[$priority"
		if [ "$component" != "" ]; then
			labels="$labels, $component"
		fi
		labels="$labels, $status]"

		# Format issue line
		issue_line="$counter. #$number: $title $labels"

		# Track special cases
		if [ "$status" = "S-Blocked" ]; then
			blocked_issues+=("#$number")
		elif [ -z "$next_issue" ] && [ "$status" != "S-InProgress" ] && [ "$status" != "S-Blocked" ]; then
			next_issue="#$number"
		fi

		echo "$issue_line"
		((counter++))
	done < <(
		while IFS=$'\t' read -r priority status component number title; do
			score=$(get_priority_score "$priority" "$status")
			printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$score" "$priority" "$status" "$component" "$number" "$title"
		done < <(
			echo "$issues_data" | jq -r '.[] | [(.priority // "P3-Medium"), (.status // "S-Ready"), ((.component // "") | if . == "" then "__NONE__" else . end), (.number | tostring), .title] | @tsv'
		) | sort -t$'\t' -k1,1nr -k2,2 -k3,3r -k5,5n
	)

echo ""

# Show recommendations
if [ ! -z "$next_issue" ]; then
	echo "💡 Next recommended work: $next_issue (ready to start)"
fi

# Show blocked issues
if [ ${#blocked_issues[@]} -gt 0 ]; then
	echo "🚫 Blocked issues: ${blocked_issues[*]} (resolve dependencies first)"
fi

# Show in progress
in_progress=$(gh issue list --label "S-InProgress" --state open --json number --jq '.[] | "#\(.number)"' 2>/dev/null | tr '\n' ' ')
if [ ! -z "$in_progress" ]; then
	echo "🔄 Currently in progress: $in_progress"
fi

echo ""
echo "Commands:"
echo "  gh issue view <number>                    - View issue details"
echo "  ./scripts/gh-update-labels.sh <number>   - Update issue labels"
echo "  ./scripts/gh-priority-order.sh --help    - Show labeling guide"

# Show help if requested
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
	echo ""
	echo "LABELING SYSTEM GUIDE"
	echo "===================="
	echo ""
	echo "Priority Labels (P):"
	echo "  P1-Critical  🔴 Critical priority, blocks other work"
	echo "  P2-High      🟠 High priority, next release"
	echo "  P3-Medium    🟡 Medium priority, upcoming releases"
	echo "  P4-Low       🟢 Low priority, future releases"
	echo ""
	echo "Status Labels (S):"
	echo "  S-Ready      🟢 Ready to work on"
	echo "  S-InProgress 🔵 Currently being worked"
	echo "  S-Blocked    🟣 Blocked by dependencies"
	echo "  S-Blocking   🟣 Blocks other work"
	echo ""
	echo "Component Labels (C):"
	echo "  C-Training      Training/ML model related"
	echo "  C-Dataset       Dataset management"
	echo "  C-Evaluation    Model evaluation"
	echo "  C-Infrastructure Core infrastructure"
	echo ""
	echo "Quick Commands:"
	echo "  ./scripts/gh-update-labels.sh 14 start      # Mark as in progress"
	echo "  ./scripts/gh-update-labels.sh 14 ready      # Mark as ready"
	echo "  ./scripts/gh-update-labels.sh 14 block      # Mark as blocked"
	echo "  ./scripts/gh-update-labels.sh 14 priority P2-High"
	echo "  ./scripts/gh-update-labels.sh 14 component C-Infrastructure"
fi
