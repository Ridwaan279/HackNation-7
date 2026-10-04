#!/usr/bin/env sh
# Builds web/downloads/Apprentice-Windows.zip from the last commit. That is the file the website's
# "Download for Windows" button serves. Run it, commit the zip, push.
set -e
cd "$(dirname "$0")/.."
mkdir -p web/downloads
git archive --format=zip --prefix=Apprentice/ -o web/downloads/Apprentice-Windows.zip HEAD app sidecar config shared start.bat README.md
echo "Wrote web/downloads/Apprentice-Windows.zip ($(du -h web/downloads/Apprentice-Windows.zip | cut -f1)). Commit it and push."
