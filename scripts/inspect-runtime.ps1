param([int]$TargetProcessId, [switch]$Serve)
$ErrorActionPreference = 'Stop'
function Get-RuntimeIdentity([int]$TargetProcessId) {
$entry = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId"
if (-not $entry) { return $null }
$directory = & (Join-Path $PSScriptRoot 'process-directory.ps1') -ProcessIds $TargetProcessId
[pscustomobject]@{
  pid = [int]$entry.ProcessId
  parentPid = [int]$entry.ParentProcessId
  created = $entry.CreationDate.ToUniversalTime().ToString('o')
  executable = $entry.ExecutablePath
  directory = $directory.Directory
  commandLine = $directory.CommandLine
}
}
if (-not $Serve) { Get-RuntimeIdentity $TargetProcessId | ConvertTo-Json -Compress; exit 0 }
# One local helper keeps native metadata code warm. Its stdin contains PIDs only.
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $requestId = $null
  try {
    if ($line.Length -gt 1024) { throw 'Invalid metadata request' }
    $request = $line | ConvertFrom-Json
    $requestId = $request.id
    if ($requestId -notmatch '^[a-f0-9]{32}$' -or $request.pid -le 0 -or $request.pid -gt [int]::MaxValue) { throw 'Invalid metadata request' }
    [pscustomobject]@{ id=$requestId; value=(Get-RuntimeIdentity ([int]$request.pid)) } | ConvertTo-Json -Compress -Depth 4 | Write-Output
  } catch {
    [pscustomobject]@{ id=$requestId; failed=$true } | ConvertTo-Json -Compress | Write-Output
  }
}
