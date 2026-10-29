param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$targetDirectory = [IO.Path]::GetFullPath($Destination)
$archivePath = [IO.Path]::GetFullPath($Archive)
if (-not $archivePath.StartsWith($targetDirectory + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive must be in the setup staging directory.' }
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  if ($zip.Entries.Count -gt 100) { throw 'Too many archive entries.' }
  $expandedBytes = 0L
  foreach ($entry in $zip.Entries) {
    $expandedBytes += $entry.Length
    if ($expandedBytes -gt 200MB -or $entry.FullName -match '(^|[\/])\.\.([\/]|$)' -or [IO.Path]::IsPathRooted($entry.FullName)) { throw 'Unsafe archive entry.' }
    $name = [IO.Path]::GetFileName($entry.FullName)
    if ($name -notmatch '^(whisper-(server|cli)\.exe|(libwhisper|whisper|ggml(-[a-z0-9]+)*)\.dll)$') { continue }
    $target = [IO.Path]::GetFullPath((Join-Path $targetDirectory $name))
    if (-not $target.StartsWith($targetDirectory + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe extraction target.' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$false)
  }
} finally { $zip.Dispose() }
