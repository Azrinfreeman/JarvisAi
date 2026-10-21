$ErrorActionPreference='Stop'
$combinedRoot=Split-Path $PSScriptRoot -Parent
$frontLocks=@(Get-ChildItem -Path (Join-Path $combinedRoot 'data\frontend\*\runtime.lock'))
if ($frontLocks.Count -ne 1) { throw 'Expected one frontend lock; inspect ownership manually' }
$frontLock=$frontLocks[0].FullName
$workerLock=Join-Path $combinedRoot 'data\ai\runtime.lock'
$frontPid=[int](Get-Content -LiteralPath $frontLock -Raw).Trim()
$workerPid=[int](Get-Content -LiteralPath $workerLock -Raw).Trim()
$verified=@(& (Join-Path $PSScriptRoot 'process-directory.ps1') -ProcessIds $frontPid,$workerPid)
foreach ($entry in $verified) { if ($entry.Directory.TrimEnd('\') -ne $combinedRoot.TrimEnd('\')) { throw 'Process directory does not match this combined project' } }
$front=$verified | Where-Object ProcessId -eq $frontPid
$worker=$verified | Where-Object ProcessId -eq $workerPid
if ($front.CommandLine -notmatch 'src[/\\]main\.ts' -or $worker.CommandLine -notmatch 'src[/\\]integration[/\\]ai-worker\.ts') { throw 'Combined process entry points do not match' }
$workerMetadata=Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid"
if ($workerMetadata.ParentProcessId -ne $frontPid) { throw 'AI worker is not a child of this frontend' }
$frontHandle=Get-Process -Id $frontPid
$workerHandle=Get-Process -Id $workerPid
Stop-Process -Id $frontPid -Force
if (-not $frontHandle.WaitForExit(5000)) { throw 'Frontend did not exit' }
# Parent IPC disconnect normally exits the worker and releases its own lock.
if (-not $workerHandle.WaitForExit(5000)) { Stop-Process -Id $workerPid -Force; if (-not $workerHandle.WaitForExit(5000)) { throw 'Worker did not exit' } }
if (Get-Process -Id $frontPid,$workerPid -ErrorAction SilentlyContinue) { throw 'A verified combined process is still running' }
foreach ($entry in @(@($frontLock,$frontPid),@($workerLock,$workerPid))) {
  if ((Test-Path -LiteralPath $entry[0]) -and (Get-Content -LiteralPath $entry[0] -Raw).Trim() -eq [string]$entry[1]) { Remove-Item -LiteralPath $entry[0] }
}
Write-Output 'Stopped only the verified combined frontend and its child. Saved sleep session state is preserved for restoration.'
