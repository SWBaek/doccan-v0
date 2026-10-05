param([int]$Port = 52741, [string]$Data = "$PSScriptRoot/data")
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (!(Test-Path .venv/Scripts/python.exe)) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment setup failed' }
    & ./.venv/Scripts/python -m pip install -r requirements-lock.txt
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
}
if (!(Test-Path "$Data/manifest.json")) {
    & ./.venv/Scripts/python -m candoc.cli init --data $Data
    if ($LASTEXITCODE -ne 0) { throw 'Asset initialization failed' }
}
& ./.venv/Scripts/python -m candoc.server --data $Data --port $Port
