# فحص "هل المؤشر فوق ملف بالمستكشف؟"
#
# البرنامج بيفتح هالملف مرة وحدة ويضل شغّال بالخلفية (PowerShell + UI Automation).
# بيقرأ سطر من الإدخال بالشكل:  x,y
# وبيرد بسطر:  1 (فوق ملف) أو 0 (مش فوق ملف).
# أول ما يجهز بيطبع READY.

$ErrorActionPreference = 'Stop'

# الإحداثيات اللي بتيجي من رصد الماوس فيزيائية — لازم العملية تكون Per-Monitor-V2
# عشان FromPoint يفهمها صح على الشاشات المختلفة.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FcDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
"@
try { [FcDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-ExplorerIds {
  try {
    return @(Get-Process explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  } catch {
    return @()
  }
}

function Test-FileAt([double]$x, [double]$y) {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($x, $y))
  } catch {
    return 0
  }
  if (-not $el) { return 0 }

  $ids = Get-ExplorerIds
  if ($ids.Count -eq 0) { return 0 }

  $cur = $el
  for ($i = 0; $i -lt 12 -and $cur; $i++) {
    try {
      $ct = $cur.Current.ControlType
      $procId = $cur.Current.ProcessId
      if (($ct -eq [System.Windows.Automation.ControlType]::ListItem -or
           $ct -eq [System.Windows.Automation.ControlType]::DataItem) -and
          ($ids -contains $procId)) {
        return 1
      }
    } catch { }
    try {
      $cur = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur)
    } catch {
      break
    }
  }
  return 0
}

# تسخين بسيط عشان أول سؤال حقيقي يكون سريع
try { $null = Test-FileAt 1 1 } catch { }

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

$inv = [System.Globalization.CultureInfo]::InvariantCulture

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }

  $parts = $line.Split(',')
  if ($parts.Count -ne 2) {
    [Console]::Out.WriteLine('0')
    [Console]::Out.Flush()
    continue
  }

  $r = 0
  try {
    $x = [double]::Parse($parts[0], $inv)
    $y = [double]::Parse($parts[1], $inv)
    $r = Test-FileAt $x $y
  } catch {
    $r = 0
  }

  [Console]::Out.WriteLine($r)
  [Console]::Out.Flush()
}
