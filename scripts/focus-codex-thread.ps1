param(
  [Parameter(Mandatory = $true)][string]$Match,
  [int]$TimeoutSec = 25,
  [switch]$Topmost,
  [switch]$NoTopmost,
  [switch]$MoveToPrimary
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AcFocus {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
[AcFocus]::SetProcessDPIAware() | Out-Null

function Get-CodexWindow {
  $candidates = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'ChatGPT|Codex' } | Select-Object -First 1
  if ($candidates) { return $candidates }
  $fallback = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($fallback) { return $fallback }
  throw 'Codex/ChatGPT window not found'
}

function Focus-Window([IntPtr]$handle) {
  if ([AcFocus]::IsIconic($handle)) { [AcFocus]::ShowWindow($handle, 9) | Out-Null }
  [AcFocus]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 250
}

function Get-DocumentName($root) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($element in $all) {
    try {
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { return $element.Current.Name }
    } catch {}
  }
  return ''
}

function Invoke-Element($element) {
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return $true
  } catch {}
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
    return $true
  } catch {}
  try {
    $rect = $element.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { return $false }
    $x = [int]($rect.X + $rect.Width / 2)
    $y = [int]($rect.Y + $rect.Height / 2)
    [AcFocus]::SetCursorPos($x, $y) | Out-Null
    [AcFocus]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [AcFocus]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    return $true
  } catch {}
  return $false
}

$window = Get-CodexWindow
Focus-Window $window.MainWindowHandle
$root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
$before = Get-DocumentName $root

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$target = $null
while ((Get-Date) -lt $deadline) {
  try {
    $window = Get-CodexWindow
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($element in $all) {
      try {
        if ($element.Current.Name -and $element.Current.Name.Contains($Match) -and $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { $target = $element; break }
      } catch {}
    }
    if (-not $target) {
      foreach ($element in $all) {
        try {
          if ($element.Current.Name -and $element.Current.Name.Contains($Match) -and $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem) { $target = $element; break }
        } catch {}
      }
    }
    if ($target) { break }
  } catch {}
  Start-Sleep -Milliseconds 400
}
if (-not $target) { Write-Error "Codex thread not found: $Match"; exit 2 }
"FOUND: $($target.Current.ControlType.ProgrammaticName) $($target.Current.Name)"

if (-not (Invoke-Element $target)) { Write-Error 'Could not open the Codex thread'; exit 3 }

$opened = $false
$after = $before
for ($attempt = 0; $attempt -lt 10; $attempt++) {
  Start-Sleep -Milliseconds 300
  try {
    $window = Get-CodexWindow
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
    $after = Get-DocumentName $root
    if ($after -and ($after -ne $before -or $after.Contains($Match))) { $opened = $true; break }
  } catch {}
}
if (-not $opened) {
  try {
    $rect = $target.Current.BoundingRectangle
    if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
      $x = [int]($rect.X + $rect.Width / 2)
      $y = [int]($rect.Y + $rect.Height / 2)
      [AcFocus]::SetCursorPos($x, $y) | Out-Null
      [AcFocus]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      [AcFocus]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 600
      $after = Get-DocumentName $root
      if ($after -and ($after -ne $before -or $after.Contains($Match))) { $opened = $true }
    }
  } catch {}
}
if (-not $opened) { Write-Error "Codex thread found but did not open: $Match"; exit 3 }

if ($MoveToPrimary) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  [AcFocus]::SetWindowPos($window.MainWindowHandle, [IntPtr](-2), $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height, 0x0040) | Out-Null
}
if ($Topmost -and -not $NoTopmost) {
  [AcFocus]::SetWindowPos($window.MainWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0013) | Out-Null
}
[AcFocus]::SetForegroundWindow($window.MainWindowHandle) | Out-Null
'OPENED'
