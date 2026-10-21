param([Parameter(Mandatory=$true)][int]$JarvisProcessId,[Parameter(Mandatory=$true)][int]$SleepProcessId)
$ErrorActionPreference='Stop'
$combinedRoot=Split-Path $PSScriptRoot -Parent
$jarvisRoot=[IO.Path]::GetFullPath((Join-Path $combinedRoot '..')).TrimEnd('\')
$sleepRoot=[IO.Path]::GetFullPath((Join-Path $combinedRoot '..\..\DiscordSleepBot')).TrimEnd('\')
$verified=@(& (Join-Path $PSScriptRoot 'process-directory.ps1') -ProcessIds $JarvisProcessId,$SleepProcessId)
$jarvis=$verified | Where-Object ProcessId -eq $JarvisProcessId
$sleep=$verified | Where-Object ProcessId -eq $SleepProcessId
if ($jarvis.Directory.TrimEnd('\') -ne $jarvisRoot -or $jarvis.CommandLine -notmatch 'src[/\\]main\.ts') { throw 'Original Jarvis process identity does not match' }
if ($sleep.Directory.TrimEnd('\') -ne $sleepRoot -or $sleep.CommandLine -notmatch 'src[/\\]index\.js') { throw 'Original sleep process identity does not match' }
$lock=Join-Path $jarvisRoot 'data\runtime.lock'
if ((Get-Content -LiteralPath $lock -Raw).Trim() -ne [string]$JarvisProcessId) { throw 'Original Jarvis lock owner does not match verified process' }
$handles=@(Get-Process -Id $JarvisProcessId,$SleepProcessId)
foreach ($handle in $handles) { Stop-Process -Id $handle.Id -Force; if (-not $handle.WaitForExit(5000)) { throw 'An original bot did not exit' } }
if (Get-Process -Id $JarvisProcessId,$SleepProcessId -ErrorAction SilentlyContinue) { throw 'An original process is still running' }
if ((Get-Content -LiteralPath $lock -Raw).Trim() -eq [string]$JarvisProcessId) { Remove-Item -LiteralPath $lock }
Write-Output 'Verified original Jarvis and sleep bot processes stopped. Cleared only the exited Jarvis owner lock; original data and source preserved.'
