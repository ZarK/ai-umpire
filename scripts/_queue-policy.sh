#!/usr/bin/env bash

queue_policy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUEUE_POLICY_PATH="${QUEUE_POLICY_PATH:-$(cd "$queue_policy_dir/.." && pwd)/queue-policy.json}"

if [ ! -f "$QUEUE_POLICY_PATH" ]; then
	printf '❌ Queue policy file not found: %s\n' "$QUEUE_POLICY_PATH" >&2
	return 1 2>/dev/null || exit 1
fi

if ! jq -e '
	.version == 1 and
	(.defaults.priorityKey | type == "string" and length > 0) and
	(.defaults.statusKey | type == "string" and length > 0) and
	(.priorities | type == "array" and length > 0) and
	all(.priorities[]; (.key | type == "string" and length > 0) and (.name | type == "string" and length > 0) and (.color | type == "string" and length > 0) and (.description | type == "string" and length > 0) and (.emoji | type == "string" and length > 0) and (.score | type == "number") and (.createIssue | type == "boolean")) and
	(.statuses | type == "array" and length > 0) and
	all(.statuses[]; (.key | type == "string" and length > 0) and (.name | type == "string" and length > 0) and (.color | type == "string" and length > 0) and (.description | type == "string" and length > 0) and (.emoji | type == "string" and length > 0) and (.scoreModifier | type == "number") and (.createIssue | type == "boolean")) and
	(.components.prefix | type == "string" and length > 0) and
	(.components.labels | type == "array") and
	all(.components.labels[]?; (.name | type == "string" and length > 0) and (.color | type == "string" and length > 0) and (.description | type == "string" and length > 0)) and
	(.transitions | type == "object") and
	all(.transitions[]; (.add | type == "string" and length > 0) and (.remove | type == "array") and all(.remove[]; type == "string" and length > 0) and (.description | type == "string" and length > 0)) and
	(.issueCreation.ensureLabelsCommand | type == "string" and length > 0) and
	(.issueCreation.dependencyLine | type == "string" and length > 0) and
	(.issueCreation.sequenceGuidance | type == "string" and length > 0)
' "$QUEUE_POLICY_PATH" >/dev/null; then
	printf '❌ Queue policy file is invalid: %s\n' "$QUEUE_POLICY_PATH" >&2
	return 1 2>/dev/null || exit 1
fi

QUEUE_PRIORITY_KEYS=()
QUEUE_PRIORITY_NAMES=()
QUEUE_PRIORITY_COLORS=()
QUEUE_PRIORITY_DESCRIPTIONS=()
QUEUE_PRIORITY_SCORES=()
QUEUE_PRIORITY_EMOJIS=()
QUEUE_PRIORITY_CREATE_FLAGS=()

while IFS=$'\t' read -r key name color description score emoji create_issue; do
	QUEUE_PRIORITY_KEYS+=("$key")
	QUEUE_PRIORITY_NAMES+=("$name")
	QUEUE_PRIORITY_COLORS+=("$color")
	QUEUE_PRIORITY_DESCRIPTIONS+=("$description")
	QUEUE_PRIORITY_SCORES+=("$score")
	QUEUE_PRIORITY_EMOJIS+=("$emoji")
	QUEUE_PRIORITY_CREATE_FLAGS+=("$create_issue")
done < <(
	jq -r '.priorities[] | [.key, .name, .color, .description, (.score | tostring), .emoji, (if .createIssue then "true" else "false" end)] | @tsv' "$QUEUE_POLICY_PATH"
)

QUEUE_STATUS_KEYS=()
QUEUE_STATUS_NAMES=()
QUEUE_STATUS_COLORS=()
QUEUE_STATUS_DESCRIPTIONS=()
QUEUE_STATUS_MODIFIERS=()
QUEUE_STATUS_EMOJIS=()
QUEUE_STATUS_CREATE_FLAGS=()

while IFS=$'\t' read -r key name color description score_modifier emoji create_issue; do
	QUEUE_STATUS_KEYS+=("$key")
	QUEUE_STATUS_NAMES+=("$name")
	QUEUE_STATUS_COLORS+=("$color")
	QUEUE_STATUS_DESCRIPTIONS+=("$description")
	QUEUE_STATUS_MODIFIERS+=("$score_modifier")
	QUEUE_STATUS_EMOJIS+=("$emoji")
	QUEUE_STATUS_CREATE_FLAGS+=("$create_issue")
done < <(
	jq -r '.statuses[] | [.key, .name, .color, .description, (.scoreModifier | tostring), .emoji, (if .createIssue then "true" else "false" end)] | @tsv' "$QUEUE_POLICY_PATH"
)

QUEUE_COMPONENT_PREFIX="$(jq -r '.components.prefix' "$QUEUE_POLICY_PATH")"
QUEUE_COMPONENT_NAMES=()
QUEUE_COMPONENT_COLORS=()
QUEUE_COMPONENT_DESCRIPTIONS=()

while IFS=$'\t' read -r name color description; do
	QUEUE_COMPONENT_NAMES+=("$name")
	QUEUE_COMPONENT_COLORS+=("$color")
	QUEUE_COMPONENT_DESCRIPTIONS+=("$description")
done < <(
	jq -r '.components.labels[]? | [.name, .color, .description] | @tsv' "$QUEUE_POLICY_PATH"
)

queue_policy_fail() {
	printf '❌ %s\n' "$1" >&2
	return 1 2>/dev/null || exit 1
}

queue_array_contains() {
	local needle="$1"
	shift || true
	local value

	for value in "$@"; do
		if [ "$value" = "$needle" ]; then
			return 0
		fi
	done

	return 1
}

queue_assert_unique_values() {
	local label="$1"
	shift || true
	local value
	local seen_values=()

	for value in "$@"; do
		if [ "${#seen_values[@]}" -gt 0 ] && queue_array_contains "$value" "${seen_values[@]}"; then
			queue_policy_fail "Queue policy has duplicate ${label}: ${value}"
		fi

		seen_values+=("$value")
	done
}

queue_assert_required_key() {
	local label="$1"
	local required_key="$2"
	shift 2 || true

	if ! queue_array_contains "$required_key" "$@"; then
		queue_policy_fail "Queue policy is missing required ${label}: ${required_key}"
	fi
}

queue_assert_any_create_flags() {
	local label="$1"
	shift || true
	local flag

	for flag in "$@"; do
		if [ "$flag" = "true" ]; then
			return 0
		fi
	done

	queue_policy_fail "Queue policy must enable at least one ${label} label for issue creation"
}

queue_assert_unique_values "priority key" "${QUEUE_PRIORITY_KEYS[@]}"
queue_assert_unique_values "priority name" "${QUEUE_PRIORITY_NAMES[@]}"
queue_assert_unique_values "status key" "${QUEUE_STATUS_KEYS[@]}"
queue_assert_unique_values "status name" "${QUEUE_STATUS_NAMES[@]}"
queue_assert_any_create_flags "priority" "${QUEUE_PRIORITY_CREATE_FLAGS[@]}"
queue_assert_any_create_flags "status" "${QUEUE_STATUS_CREATE_FLAGS[@]}"

if [ "${#QUEUE_COMPONENT_NAMES[@]}" -gt 0 ]; then
	queue_assert_unique_values "component name" "${QUEUE_COMPONENT_NAMES[@]}"
fi

QUEUE_DEFAULT_PRIORITY_KEY="$(jq -r '.defaults.priorityKey' "$QUEUE_POLICY_PATH")"
QUEUE_DEFAULT_STATUS_KEY="$(jq -r '.defaults.statusKey' "$QUEUE_POLICY_PATH")"

queue_assert_required_key "status key" "ready" "${QUEUE_STATUS_KEYS[@]}"
queue_assert_required_key "status key" "in_progress" "${QUEUE_STATUS_KEYS[@]}"
queue_assert_required_key "status key" "blocked" "${QUEUE_STATUS_KEYS[@]}"
queue_assert_required_key "status key" "blocking" "${QUEUE_STATUS_KEYS[@]}"

if ! queue_array_contains "$QUEUE_DEFAULT_PRIORITY_KEY" "${QUEUE_PRIORITY_KEYS[@]}"; then
	queue_policy_fail "Queue policy defaults.priorityKey must reference a defined priority"
fi

if ! queue_array_contains "$QUEUE_DEFAULT_STATUS_KEY" "${QUEUE_STATUS_KEYS[@]}"; then
	queue_policy_fail "Queue policy defaults.statusKey must reference a defined status"
fi

if [ "${#QUEUE_COMPONENT_NAMES[@]}" -gt 0 ]; then
	for component_name in "${QUEUE_COMPONENT_NAMES[@]}"; do
		case "$component_name" in
		"${QUEUE_COMPONENT_PREFIX}"*) ;;
		*)
			queue_policy_fail "Queue policy component label must start with ${QUEUE_COMPONENT_PREFIX}: ${component_name}"
			;;
		esac
	done
fi

for transition_name in ready start block unblock; do
	if ! jq -e --arg action "$transition_name" '.transitions[$action] | type == "object"' "$QUEUE_POLICY_PATH" >/dev/null; then
		queue_policy_fail "Queue policy is missing required transition: ${transition_name}"
	fi

	transition_add_key="$(jq -r --arg action "$transition_name" '.transitions[$action].add // empty' "$QUEUE_POLICY_PATH")"
	if ! queue_array_contains "$transition_add_key" "${QUEUE_STATUS_KEYS[@]}"; then
		queue_policy_fail "Queue policy transition ${transition_name} add key must reference a defined status"
	fi

	while IFS= read -r transition_remove_key; do
		[ -n "$transition_remove_key" ] || continue
		if ! queue_array_contains "$transition_remove_key" "${QUEUE_STATUS_KEYS[@]}"; then
			queue_policy_fail "Queue policy transition ${transition_name} remove key must reference a defined status"
		fi
	done < <(jq -r --arg action "$transition_name" '.transitions[$action].remove[]? // empty' "$QUEUE_POLICY_PATH")
done

queue_join_with_delimiter() {
	local delimiter="$1"
	shift || true
	local joined=""
	local value

	for value in "$@"; do
		if [ -n "$joined" ]; then
			joined="${joined}${delimiter}${value}"
		else
			joined="$value"
		fi
	done

	printf '%s\n' "$joined"
}

queue_priority_name_by_key() {
	local wanted_key="$1"
	local index

	for index in "${!QUEUE_PRIORITY_KEYS[@]}"; do
		if [ "${QUEUE_PRIORITY_KEYS[$index]}" = "$wanted_key" ]; then
			printf '%s\n' "${QUEUE_PRIORITY_NAMES[$index]}"
			return 0
		fi
	done

	return 1
}

queue_status_name_by_key() {
	local wanted_key="$1"
	local index

	for index in "${!QUEUE_STATUS_KEYS[@]}"; do
		if [ "${QUEUE_STATUS_KEYS[$index]}" = "$wanted_key" ]; then
			printf '%s\n' "${QUEUE_STATUS_NAMES[$index]}"
			return 0
		fi
	done

	return 1
}

queue_is_priority_label() {
	local candidate="$1"
	local label

	for label in "${QUEUE_PRIORITY_NAMES[@]}"; do
		if [ "$label" = "$candidate" ]; then
			return 0
		fi
	done

	return 1
}

queue_is_status_label() {
	local candidate="$1"
	local label

	for label in "${QUEUE_STATUS_NAMES[@]}"; do
		if [ "$label" = "$candidate" ]; then
			return 0
		fi
	done

	return 1
}

queue_has_component_taxonomy() {
	[ "${#QUEUE_COMPONENT_NAMES[@]}" -gt 0 ]
}

queue_is_component_label() {
	local candidate="$1"
	local label

	if ! queue_has_component_taxonomy; then
		return 1
	fi

	for label in "${QUEUE_COMPONENT_NAMES[@]}"; do
		if [ "$label" = "$candidate" ]; then
			return 0
		fi
	done

	return 1
}

queue_priority_score() {
	local candidate="$1"
	local index

	for index in "${!QUEUE_PRIORITY_NAMES[@]}"; do
		if [ "${QUEUE_PRIORITY_NAMES[$index]}" = "$candidate" ]; then
			printf '%s\n' "${QUEUE_PRIORITY_SCORES[$index]}"
			return 0
		fi
	done

	printf '50\n'
}

queue_status_modifier() {
	local candidate="$1"
	local index

	for index in "${!QUEUE_STATUS_NAMES[@]}"; do
		if [ "${QUEUE_STATUS_NAMES[$index]}" = "$candidate" ]; then
			printf '%s\n' "${QUEUE_STATUS_MODIFIERS[$index]}"
			return 0
		fi
	done

	printf '0\n'
}

queue_priority_labels_csv() {
	queue_join_with_delimiter "," "${QUEUE_PRIORITY_NAMES[@]}"
}

queue_status_labels_csv() {
	queue_join_with_delimiter "," "${QUEUE_STATUS_NAMES[@]}"
}

queue_priority_labels_pipe() {
	queue_join_with_delimiter "|" "${QUEUE_PRIORITY_NAMES[@]}"
}

queue_status_labels_pipe() {
	queue_join_with_delimiter "|" "${QUEUE_STATUS_NAMES[@]}"
}

queue_component_labels_pipe() {
	queue_join_with_delimiter "|" "${QUEUE_COMPONENT_NAMES[@]}"
}

queue_priority_labels_json() {
	printf '%s\n' "${QUEUE_PRIORITY_NAMES[@]}" | jq -R . | jq -s '.'
}

queue_status_labels_json() {
	printf '%s\n' "${QUEUE_STATUS_NAMES[@]}" | jq -R . | jq -s '.'
}

queue_transition_add_label() {
	local action="$1"
	local status_key

	status_key="$(jq -r --arg action "$action" '.transitions[$action].add' "$QUEUE_POLICY_PATH")"
	queue_status_name_by_key "$status_key"
}

queue_transition_remove_csv() {
	local action="$1"

	jq -r --arg action "$action" '[.transitions[$action].remove[] as $statusKey | .statuses[] | select(.key == $statusKey) | .name] | join(",")' "$QUEUE_POLICY_PATH"
}

queue_transition_description() {
	local action="$1"

	jq -r --arg action "$action" '.transitions[$action].description' "$QUEUE_POLICY_PATH"
}

queue_print_priority_help() {
	local index

	for index in "${!QUEUE_PRIORITY_NAMES[@]}"; do
		printf '  %-12s %s %s\n' "${QUEUE_PRIORITY_NAMES[$index]}" "${QUEUE_PRIORITY_EMOJIS[$index]}" "${QUEUE_PRIORITY_DESCRIPTIONS[$index]}"
	done
}

queue_print_status_help() {
	local index

	for index in "${!QUEUE_STATUS_NAMES[@]}"; do
		printf '  %-12s %s %s\n' "${QUEUE_STATUS_NAMES[$index]}" "${QUEUE_STATUS_EMOJIS[$index]}" "${QUEUE_STATUS_DESCRIPTIONS[$index]}"
	done
}

queue_print_component_help() {
	local index

	if ! queue_has_component_taxonomy; then
		echo "  No stable component labels configured for this repository."
		return 0
	fi

	for index in "${!QUEUE_COMPONENT_NAMES[@]}"; do
		printf '  %-16s %s\n' "${QUEUE_COMPONENT_NAMES[$index]}" "${QUEUE_COMPONENT_DESCRIPTIONS[$index]}"
	done
}

QUEUE_DEFAULT_PRIORITY="$(queue_priority_name_by_key "$QUEUE_DEFAULT_PRIORITY_KEY")"
QUEUE_DEFAULT_STATUS="$(queue_status_name_by_key "$QUEUE_DEFAULT_STATUS_KEY")"
QUEUE_READY_STATUS="$(queue_status_name_by_key "ready")"
QUEUE_IN_PROGRESS_STATUS="$(queue_status_name_by_key "in_progress")"
QUEUE_BLOCKED_STATUS="$(queue_status_name_by_key "blocked")"
QUEUE_BLOCKING_STATUS="$(queue_status_name_by_key "blocking")"
