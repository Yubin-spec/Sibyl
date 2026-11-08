param(
  [Parameter(Mandatory = $true)][string]$Match,
  [int]$TimeoutSec = 25,
  [switch]$NoTopmost
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AcFocus {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
function Get-CodexWindow {
  $candidates = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'ChatGPT|Codex' } | Select-Object -First 1
  if ($candidates) { return $candidates }
  $fallback = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($fallback) { return $fallback }
  throw 'Codex/ChatGPT window not found'
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
    $x = [int]($rect.X + $rect.Width / 2)
    $y = [int]($rect.Y + $rect.Height / 2)
    [AcFocus]::SetCursorPos($x, $y) | Out-Null
    [AcFocus]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [AcFocus]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    return $true
  } catch {}
  return $false
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$window = $null
$target = $null
while ((Get-Date) -lt $deadline) {
  try {
    $window = Get-CodexWindow
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($element in $all) {
      try {
        if ($element.Current.Name -and $element.Current.Name.Contains($Match)) {
          if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { $target = $element; break }
        }
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

Start-Sleep -Milliseconds 600
$window = Get-CodexWindow
[AcFocus]::ShowWindow($window.MainWindowHandle, 9) | Out-Null
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$after = if ($NoTopmost) { [IntPtr](-2) } else { [IntPtr](-1) }
[AcFocus]::SetWindowPos($window.MainWindowHandle, $after, $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height, 0x0040) | Out-Null
[AcFocus]::SetForegroundWindow($window.MainWindowHandle) | Out-Null
'OPENED'
