param(
  [string]$Action = 'drag',   # drag | release | press | shiftdown | shiftup | moveto | mouseup | cursor
  [int]$X = 700,
  [int]$Y = 500,
  [switch]$NoShift
)

# كل الأحداث بتنبعت بـ SendInput عشان توصل للـ low-level hook وبتكون بإحداثيات فيزيائية دقيقة.
# (SetCursorPos ما بيولّد أحداث WH_MOUSE_LL، و mouse_event النسبي بيتأثر بتسريع الماوس.)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class Inj {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags;
    public uint time; public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags;
    public uint time; public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg; public ushort wParamL; public ushort wParamH;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  static int W { get { return GetSystemMetrics(78); } }
  static int H { get { return GetSystemMetrics(79); } }
  static int OX { get { return GetSystemMetrics(76); } }
  static int OY { get { return GetSystemMetrics(77); } }

  public static bool MoveAbs(int x, int y) {
    INPUT[] a = new INPUT[1];
    a[0].type = 0;
    a[0].u.mi.dx = (int)Math.Round((x - OX) * 65535.0 / (W - 1));
    a[0].u.mi.dy = (int)Math.Round((y - OY) * 65535.0 / (H - 1));
    a[0].u.mi.dwFlags = 0x0001 | 0x8000 | 0x4000; // MOVE | ABSOLUTE | VIRTUALDESK
    return SendInput(1, a, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  public static bool Mouse(uint flags) {
    INPUT[] a = new INPUT[1];
    a[0].type = 0;
    a[0].u.mi.dwFlags = flags;
    return SendInput(1, a, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  public static bool MouseRel(int dx, int dy) {
    INPUT[] a = new INPUT[1];
    a[0].type = 0;
    a[0].u.mi.dx = dx;
    a[0].u.mi.dy = dy;
    a[0].u.mi.dwFlags = 0x0001; // MOVE (نسبي)
    return SendInput(1, a, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  public static bool Key(ushort vk, bool up) {
    INPUT[] a = new INPUT[1];
    a[0].type = 1;
    a[0].u.ki.wVk = vk;
    a[0].u.ki.dwFlags = up ? 2u : 0u;
    return SendInput(1, a, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  public static void Init() {
    SetProcessDPIAware();
  }
}
"@

[Inj]::Init() | Out-Null

function MoveTo([int]$tx, [int]$ty) {
  # خطوات صغيرة + تصحيح نهائي (كلها absolute، فما في تسريع)
  $p = New-Object Inj+POINT
  [Inj]::GetCursorPos([ref]$p) | Out-Null
  $sx = $p.X; $sy = $p.Y
  $steps = 10
  for ($i = 1; $i -le $steps; $i++) {
    $nx = [int][Math]::Round($sx + ($tx - $sx) * $i / $steps)
    $ny = [int][Math]::Round($sy + ($ty - $sy) * $i / $steps)
    [Inj]::MoveAbs($nx, $ny) | Out-Null
    Start-Sleep -Milliseconds 30
  }
  [Inj]::MoveAbs($tx, $ty) | Out-Null
  Start-Sleep -Milliseconds 40
}

if ($Action -eq 'drag') {
  $orig = New-Object Inj+POINT
  [Inj]::GetCursorPos([ref]$orig) | Out-Null
  Set-Content -Path "$env:TEMP\converter-cursor.txt" -Value "$($orig.X),$($orig.Y)"

  [Inj]::MoveAbs($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 250
  if (-not $NoShift) {
    [Inj]::Key(0x10, $false) | Out-Null          # Shift down
    Start-Sleep -Milliseconds 180
  }
  [Inj]::Mouse(0x0002) | Out-Null                # left down
  Start-Sleep -Milliseconds 80
  foreach ($i in 1..12) {
    [Inj]::MoveAbs($X + ($i * 3), $Y + ($i * 1)) | Out-Null
    Start-Sleep -Milliseconds 45
  }
  Write-Output 'DRAG_STARTED'
}
elseif ($Action -eq 'release') {
  [Inj]::Mouse(0x0004) | Out-Null                # left up
  Start-Sleep -Milliseconds 150
  [Inj]::Key(0x10, $true) | Out-Null             # Shift up
  if (Test-Path "$env:TEMP\converter-cursor.txt") {
    $p = (Get-Content "$env:TEMP\converter-cursor.txt").Split(',')
    Start-Sleep -Milliseconds 200
    [Inj]::MoveAbs([int]$p[0], [int]$p[1]) | Out-Null
    Remove-Item "$env:TEMP\converter-cursor.txt" -Force -ErrorAction SilentlyContinue
  }
  Write-Output 'DRAG_RELEASED'
}
elseif ($Action -eq 'press') {
  [Inj]::MoveAbs($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 150
  [Inj]::Mouse(0x0002) | Out-Null
  Write-Output 'PRESSED'
}
elseif ($Action -eq 'shiftdown') {
  [Inj]::Key(0x10, $false) | Out-Null
  Write-Output 'SHIFT_DOWN'
}
elseif ($Action -eq 'shiftup') {
  [Inj]::Key(0x10, $true) | Out-Null
  Write-Output 'SHIFT_UP'
}
elseif ($Action -eq 'moveto') {
  if (-not $NoShift) { [Inj]::Key(0x10, $false) | Out-Null }
  MoveTo $X $Y
  Write-Output 'MOVED_TO'
}
elseif ($Action -eq 'relmove') {
  # حركة نسبية صغيرة (زي حركة ماوس حقيقية) — بتوصل لبعض برامج السحب اللي بتتجاهل الحركة المطلقة
  if (-not $NoShift) { [Inj]::Key(0x10, $false) | Out-Null }
  $p = New-Object Inj+POINT
  $i = 0
  while ($i -lt 400) {
    [Inj]::GetCursorPos([ref]$p) | Out-Null
    $dx = $X - $p.X
    $dy = $Y - $p.Y
    if ([Math]::Abs($dx) -le 1 -and [Math]::Abs($dy) -le 1) { break }
    $sx = [Math]::Max(-6, [Math]::Min(6, $dx))
    $sy = [Math]::Max(-6, [Math]::Min(6, $dy))
    [Inj]::MouseRel($sx, $sy) | Out-Null
    Start-Sleep -Milliseconds 12
    $i++
  }
  Write-Output "REL_MOVED $i"
}
elseif ($Action -eq 'mouseup') {
  [Inj]::Mouse(0x0004) | Out-Null
  Start-Sleep -Milliseconds 120
  [Inj]::Key(0x10, $true) | Out-Null
  Write-Output 'MOUSE_UP'
}
elseif ($Action -eq 'cursor') {
  $p = New-Object Inj+POINT
  [Inj]::GetCursorPos([ref]$p) | Out-Null
  Write-Output "$($p.X),$($p.Y)"
}
