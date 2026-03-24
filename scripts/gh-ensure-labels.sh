#!/usr/bin/env bash
set -euo pipefail

# Ensure the core priority/status labels required by the queue scripts exist.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/_queue-policy.sh"

labels=(
)

while IFS=$'\t' read -r name color description; do
	labels+=("$name|$color|$description")
done < <(
	jq -r '.priorities[], .statuses[], .components.labels[]? | [.name, .color, .description] | @tsv' "$QUEUE_POLICY_PATH"
)

existing_labels="$(gh label list --limit 200 --json name --jq '.[].name' 2>/dev/null || true)"

if [ -z "$existing_labels" ]; then
	echo "⚠️  Could not read existing labels with gh. Ensure gh is authenticated and the current directory points at the target repository."
fi

for entry in "${labels[@]}"; do
	IFS='|' read -r name color description <<<"$entry"
	if printf '%s\n' "$existing_labels" | grep -Fxq "$name"; then
		echo "✓ $name"
		continue
	fi

	gh label create "$name" --color "$color" --description "$description"
	echo "+ $name"
done
