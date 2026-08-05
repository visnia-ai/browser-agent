#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
XVFB_RUN="/usr/bin/xvfb-run"

if [[ ! -x "$XVFB_RUN" ]]; then
	echo "Missing $XVFB_RUN" >&2
	exit 1
fi

if [[ $# -lt 1 ]]; then
	echo "Usage: $(basename "$0") <config-path> [additional cli args...]" >&2
	exit 1
fi

CONFIG_PATH="$1"
shift

cd "$SCRIPT_DIR"

exec "$XVFB_RUN" \
	--auto-servernum \
	--server-args="-screen 0 1920x1080x24" \
	npx tsx cli.ts "$CONFIG_PATH" "$@"
