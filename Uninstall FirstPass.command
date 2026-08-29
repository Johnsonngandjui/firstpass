#!/bin/bash
# Double-clickable wrapper around uninstall.sh. See Install FirstPass.command
# for why this file exists rather than just uninstall.sh.

cd "$(dirname "$0")" || exit 1

./uninstall.sh
STATUS=$?

echo
echo "You can close this window, or press Return."
read -r _
exit $STATUS
