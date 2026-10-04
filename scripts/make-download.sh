#!/usr/bin/env sh
# Builds web/downloads/Protege-Windows.zip from the last commit. That is the file the website's
# "Download for Windows" button serves. Run it, commit the zip, push.
set -e
cd "$(dirname "$0")/.."
mkdir -p web/downloads
git archive --format=zip --prefix=Protege/ -o web/downloads/Protege-Windows.zip HEAD app sidecar config shared start.bat README.md
echo "Wrote web/downloads/Protege-Windows.zip ($(du -h web/downloads/Protege-Windows.zip | cut -f1)). Commit it and push."
