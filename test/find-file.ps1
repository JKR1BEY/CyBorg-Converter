param(
  [string]$FileName,
  [string]$FolderName = '',
  [switch]$EmitWindow
)

# بيدوّر على أيقونة ملف داخل نافذة المستكشف وبيرجّع مركزها بالإحداثيات الفيزيائية.
# ملاحظة: اسم العنصر بالمستكشف غالباً بدون الامتداد (explorer-drag بدل explorer-drag.png).

Add-Type -Namespace ConvNative -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[ConvNative.Dpi]::SetProcessDPIAware() | Out-Null

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$base = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
$ext = [System.IO.Path]::GetExtension($FileName)

$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CabinetWClass')
$listItemCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)

$deadline = (Get-Date).AddSeconds(20)
$item = $null
$win = $null

while ((Get-Date) -lt $deadline -and $null -eq $item) {
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
  foreach ($w in $wins) {
    $title = $w.Current.Name
    if ($FolderName -ne '' -and $title -notlike "*$FolderName*") { continue }
    # نتأكد إنه النافذة مفتوحة مش مصغّرة
    try {
      $wp = $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
      if ($wp.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
        $wp.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
        Start-Sleep -Milliseconds 350
      }
    } catch { }
    $items = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listItemCond)
    foreach ($it in $items) {
      $n = $it.Current.Name
      if ($n -eq $FileName -or $n -eq $base -or $n -eq ($base + $ext)) {
        $r0 = $it.Current.BoundingRectangle
        if ($r0.IsEmpty -or $r0.Width -lt 2) { continue }
        $item = $it
        $win = $w
        break
      }
    }
    if ($null -ne $item) { break }
  }
  if ($null -eq $item) { Start-Sleep -Milliseconds 500 }
}

if ($null -eq $item) {
  Write-Output 'NOT_FOUND'
  exit 1
}

try { $win.SetFocus() } catch { }
Start-Sleep -Milliseconds 250

$r = $item.Current.BoundingRectangle
$x = [int]([Math]::Round($r.Left + $r.Width / 2))
$y = [int]([Math]::Round($r.Top + $r.Height / 2))

$sel = 'unknown'
try {
  $pat = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $sel = if ($pat.Current.IsSelected) { 'selected' } else { 'not-selected' }
} catch { }

# تأكيد إنه فعلاً في عنصر على هالإحداثيات
$at = ''
try {
  $el = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y)))
  $at = $el.Current.Name
} catch { }

Write-Output ("{0},{1},{2},{3},{4},{5}" -f $x, $y, [int]$r.Width, [int]$r.Height, $sel, $at)

if ($EmitWindow) {
  $wr = $win.Current.BoundingRectangle
  Write-Output ("WINDOW {0},{1},{2},{3}" -f [int]$wr.X, [int]$wr.Y, [int]$wr.Width, [int]$wr.Height)
}
