param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskUrl = 'http://127.0.0.1:5186'
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist\index.html'))) {
    Write-Host 'Please run npm.cmd install and npm.cmd run build first.'
    Read-Host 'Press Enter to close'
    exit 1
}
$taskRunning = $false
try {
    $taskHealth = Invoke-RestMethod -Uri ($taskUrl + '/__health') -TimeoutSec 2
    if ($taskHealth.app -ne 'ecg-vector-learning') { throw 'Port 5186 belongs to another application.' }
    $taskRunning = $true
} catch {
    $taskConnection = Get-NetTCPConnection -LocalPort 5186 -State Listen -ErrorAction SilentlyContinue
    if ($taskConnection) { throw 'Port 5186 is in use by another application. No process was stopped.' }
}
if (-not $taskRunning) {
    $taskNode = (Get-Command node.exe -ErrorAction Stop).Source
    Start-Process -FilePath $taskNode -ArgumentList 'server.mjs' -WorkingDirectory $taskRoot -WindowStyle Hidden
    for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
        Start-Sleep -Milliseconds 200
        try { $taskHealth = Invoke-RestMethod -Uri ($taskUrl + '/__health') -TimeoutSec 1; if ($taskHealth.app -eq 'ecg-vector-learning') { $taskRunning = $true; break } } catch {}
    }
    if (-not $taskRunning) { throw 'Local server did not start. Run node server.mjs to inspect the error.' }
}
if (-not $NoBrowser) { Start-Process $taskUrl }
