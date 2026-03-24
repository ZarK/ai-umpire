#!/usr/bin/env bash
set -euo pipefail

# Quick label management script for GitHub issues

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/_queue-policy.sh"

remove_labels_by_prefix() {
	local issue_num=$1
	local prefix=$2
	local labels
	local label

	labels=$(gh issue view "$issue_num" --json labels --jq '.labels[].name' 2>/dev/null || true)
	if [ -z "$labels" ]; then
		return
	fi

	while IFS= read -r label; do
		[ -n "$label" ] || continue
		case "$label" in
		"${prefix}"*) ;;
		*) continue ;;
		esac
		gh issue edit "$issue_num" --remove-label "$label" 2>/dev/null || true
	done <<<"$labels"
}

if [ $# -lt 2 ]; then
	echo "Usage: $0 <issue_number> [action]"
	echo ""
	echo "Actions:"
	echo "  priority <$(queue_priority_labels_pipe)>"
	echo "  status <$(queue_status_labels_pipe)>"
	if queue_has_component_taxonomy; then
		echo "  component <$(queue_component_labels_pipe)>"
	else
		echo "  component <${QUEUE_COMPONENT_PREFIX}label>  # disabled: no stable component labels configured"
	fi
	echo "  epic <Epic-CVE-Monitoring|Epic-Fast-Training|Epic-CTF-System|...>"
	echo "  ready      - $(queue_transition_description ready)"
	echo "  start      - $(queue_transition_description start)"
	echo "  block      - $(queue_transition_description block)"
	echo "  unblock    - $(queue_transition_description unblock)"
	echo ""
	echo "Examples:"
	echo "  $0 14 priority ${QUEUE_PRIORITY_NAMES[1]}"
	echo "  $0 14 status ${QUEUE_READY_STATUS}"
	if queue_has_component_taxonomy; then
		echo "  $0 14 component ${QUEUE_COMPONENT_NAMES[0]}"
	fi
	echo "  $0 14 epic Epic-Fast-Training"
	echo "  $0 14 ready"
	echo "  $0 14 start"
	exit 1
fi

ISSUE_NUM=$1
ACTION="${2:-}"
VALUE="${3:-}"

case "$ACTION" in
"priority")
	if queue_is_priority_label "$VALUE"; then
		# Remove existing priority labels
		gh issue edit "$ISSUE_NUM" --remove-label "$(queue_priority_labels_csv)" 2>/dev/null
		gh issue edit "$ISSUE_NUM" --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM priority to $VALUE"
	else
		echo "❌ Invalid priority. Use $(queue_priority_labels_pipe)"
		exit 1
	fi
	;;
"status")
	if queue_is_status_label "$VALUE"; then
		# Remove existing status labels
		gh issue edit "$ISSUE_NUM" --remove-label "$(queue_status_labels_csv)" 2>/dev/null
		gh issue edit "$ISSUE_NUM" --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM status to $VALUE"
	else
		echo "❌ Invalid status. Use $(queue_status_labels_pipe)"
		exit 1
	fi
	;;
"component")
	if ! queue_has_component_taxonomy; then
		echo "❌ Component labels are not configured for this repository"
		exit 1
	elif queue_is_component_label "$VALUE"; then
		remove_labels_by_prefix "$ISSUE_NUM" "$QUEUE_COMPONENT_PREFIX"
		gh issue edit "$ISSUE_NUM" --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM component to $VALUE"
	else
		echo "❌ Invalid component. Use $(queue_component_labels_pipe)"
		exit 1
	fi
	;;
"epic")
	if [[ "$VALUE" =~ ^Epic-[A-Za-z0-9._-]+$ ]]; then
		remove_labels_by_prefix "$ISSUE_NUM" "Epic-"
		gh issue edit "$ISSUE_NUM" --add-label "$VALUE"
		echo "✅ Set issue #$ISSUE_NUM epic to $VALUE"
	else
		echo "❌ Invalid epic. Use a label that starts with Epic-"
		exit 1
	fi
	;;
"ready")
	gh issue edit "$ISSUE_NUM" --remove-label "$(queue_transition_remove_csv ready)" 2>/dev/null
	gh issue edit "$ISSUE_NUM" --add-label "$(queue_transition_add_label ready)"
	echo "✅ Marked issue #$ISSUE_NUM as ready"
	;;
"start")
	gh issue edit "$ISSUE_NUM" --remove-label "$(queue_transition_remove_csv start)" 2>/dev/null
	gh issue edit "$ISSUE_NUM" --add-label "$(queue_transition_add_label start)"
	echo "✅ Started work on issue #$ISSUE_NUM"
	;;
"block")
	gh issue edit "$ISSUE_NUM" --remove-label "$(queue_transition_remove_csv block)" 2>/dev/null
	gh issue edit "$ISSUE_NUM" --add-label "$(queue_transition_add_label block)"
	echo "🚫 Marked issue #$ISSUE_NUM as blocked"
	;;
"unblock")
	gh issue edit "$ISSUE_NUM" --remove-label "$(queue_transition_remove_csv unblock)" 2>/dev/null
	gh issue edit "$ISSUE_NUM" --add-label "$(queue_transition_add_label unblock)"
	echo "✅ Unblocked issue #$ISSUE_NUM (marked as ready)"
	;;
*)
	echo "❌ Unknown action: $ACTION"
	echo "Run '$0' with no arguments to see usage"
	exit 1
	;;
esac
