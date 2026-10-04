# Builds web\downloads\Protege-Windows.zip from the last commit. That is the file the website's
# "Download for Windows" button serves. Run it, commit the zip, push.
Set-Location (Join-Path $PSScriptRoot '..')
New-Item -ItemType Directory -Force 'web\downloads' | Out-Null
git archive --format=zip --prefix=Protege/ -o web/downloads/Protege-Windows.zip HEAD app sidecar config shared start.bat README.md
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Wrote web\downloads\Protege-Windows.zip. Commit it and push."
