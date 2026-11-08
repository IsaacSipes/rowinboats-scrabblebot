# Starts the Rowin'Boats bot.
# First run: redeems the one-time code saved in %TEMP%\stdb-install\nonce.txt.
# After that the bot's own token lives in .token-rowinboats and is reused.
$ErrorActionPreference = 'Stop'

# Pick up Node.js even if this terminal was opened before it was installed.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

Set-Location $PSScriptRoot
$env:BOT_NAME = 'rowinboats'

if (-not (Test-Path '.token-rowinboats')) {
    $nonceFile = Join-Path $env:TEMP 'stdb-install\nonce.txt'
    if (-not (Test-Path $nonceFile)) {
        throw "No saved token and no one-time code. Get a token from the Team page and run: `$env:BOT_TOKEN='...'; .\start-bot.ps1"
    }
    $env:BOT_NONCE = (Get-Content $nonceFile -Raw).Trim().Trim('"')
}

npm start
