param(
  [Parameter(Mandatory = $true)][string]$ThreadId,
  [string]$HostId = 'local'
)
$ErrorActionPreference = 'Stop'
if ($ThreadId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
  Write-Error "Invalid thread id: $ThreadId"
  exit 2
}
$url = "codex://threads/$ThreadId"
if ($HostId) { $url += '?hostId=' + [uri]::EscapeDataString($HostId) }
Start-Process $url -ErrorAction Stop
"OPENED $url"
