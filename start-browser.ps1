param([switch]$Stop, [switch]$NoOpen, [string]$DataDir)
$ErrorActionPreference = 'Stop'
$taskCandidates = @()
if ($env:SIBYL_NODE) { $taskCandidates += $env:SIBYL_NODE }
$taskCandidates += (Join-Path $PSScriptRoot '..\.tools\node26\node-v26.13.0-win-x64\node.exe')
$taskCandidates += (Join-Path $PSScriptRoot 'runtime\node.exe')
$taskSystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($taskSystemNode) { $taskCandidates += $taskSystemNode.Source }
$taskNode = $null
foreach ($taskCandidate in $taskCandidates) {
 if (Test-Path -LiteralPath $taskCandidate -PathType Leaf) {
  $taskVersion = & $taskCandidate -p 'process.versions.node' 2>$null
  if ($LASTEXITCODE -eq 0 -and [int]($taskVersion.Split('.')[0]) -ge 26) { $taskNode = (Resolve-Path -LiteralPath $taskCandidate).Path; break }
 }
}
if (-not $taskNode) { throw 'Node.js 26+ is required. Install it or set SIBYL_NODE to its node.exe path.' }
$taskArguments = @((Join-Path $PSScriptRoot 'browser.mjs'))
if ($Stop) { $taskArguments += '--stop' }
if ($NoOpen) { $taskArguments += '--no-open' }
if ($DataDir) { $taskArguments += @('--dir', $DataDir) }
& $taskNode @taskArguments
exit $LASTEXITCODE
