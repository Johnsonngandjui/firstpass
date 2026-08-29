#!/bin/bash
# Double-clickable wrapper around install.sh.
#
# macOS will not run a .sh on double-click — it opens it in a text editor, or in
# Xcode if that's installed. A .command file is the one extension Finder runs in
# Terminal, so this exists purely so nobody has to open a terminal by hand.

cd "$(dirname "$0")" || exit 1

./scripts/install.sh
STATUS=$?

echo
if [ $STATUS -ne 0 ]; then
  echo "The installer stopped early. The messages above say why."
fi
echo "You can close this window, or press Return."
read -r _
exit $STATUS
