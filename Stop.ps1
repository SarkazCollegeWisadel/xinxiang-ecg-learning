$ErrorActionPreference = 'Stop'
$taskUrl = 'http://127.0.0.1:5186/__health'
try { $taskHealth = Invoke-RestMethod -Uri $taskUrl -TimeoutSec 2 } catch { Write-Host 'The ECG learning server is not running.'; exit 0 }
if ($taskHealth.app -ne 'ecg-vector-learning') { throw 'This port belongs to another application.' }
$taskExpectedRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$taskConnections = Get-NetTCPConnection -LocalPort 5186 -State Listen -ErrorAction Stop
foreach ($taskConnection in $taskConnections) {
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskConnection.OwningProcess)"
    if ($taskProcess.Name -ne 'node.exe' -or $taskProcess.CommandLine -notmatch 'server\.mjs') { throw 'Server process could not be verified; nothing was stopped.' }
    # The health identity plus node/server.mjs signature restrict this to this application's listener.
    Stop-Process -Id $taskProcess.ProcessId
}
