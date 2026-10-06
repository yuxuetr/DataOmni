# Windows 安装包冒烟：MSI 与 NSIS 各走一遍 安装 → 启动 → 卸载，给了旧版 MSI 时先装旧版再升级。
# 在 GitHub Actions 的 windows 机器上跑（.github/workflows/windows-install.yml 与 release.yml），本机也能跑：
#   pwsh scripts/windows-install-smoke.ps1 -Msi x.msi -Nsis x-setup.exe -Version 0.6.0 [-PreviousMsi old.msi]
# 管不到的、要人看的（SmartScreen、界面、Oracle 真连）在 docs/windows-checklist.md。
param(
  [Parameter(Mandatory)][string]$Msi,
  [Parameter(Mandatory)][string]$Nsis,
  [Parameter(Mandatory)][string]$Version,
  [string]$PreviousMsi
)
$ErrorActionPreference = 'Stop'
$failures = [System.Collections.Generic.List[string]]::new()

function Check([bool]$ok, [string]$what) {
  if ($ok) { Write-Host "ok   $what" } else { Write-Host "FAIL $what"; $failures.Add($what) }
}

function Get-UninstallEntries {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'DataOmni' })
}

function Find-AppExe([string]$dir) {
  Get-ChildItem $dir -Filter *.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '^uninstall' } |
    Select-Object -First 1
}

function Find-Shortcut([string]$programs) {
  Get-ChildItem $programs -Recurse -Filter 'DataOmni*.lnk' -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Invoke-Msiexec([string[]]$arguments, [string]$what) {
  $process = Start-Process msiexec.exe -ArgumentList $arguments -Wait -PassThru
  # 3010：成功，要重启才完全生效
  Check ($process.ExitCode -in 0, 3010) "$what（msiexec 退出码 $($process.ExitCode)）"
}

# 启动后等一会儿：进程还活着，并且日志里有那一行「启动」——说明 WebView 起来之前的 setup 都跑过了
function Test-Launch([string]$installDir, [string]$label) {
  $exe = Find-AppExe $installDir
  Check ($null -ne $exe) "${label}：$installDir 里有主程序"
  if ($null -eq $exe) { return }
  Check (Test-Path (Join-Path $installDir 'instantclient\oci.dll')) "${label}：随包带着 Instant Client"
  $log = Join-Path $env:LOCALAPPDATA 'com.dataomni.app\logs\dataomni.log'
  Remove-Item $log -ErrorAction SilentlyContinue
  $process = Start-Process $exe.FullName -PassThru
  Start-Sleep -Seconds 20
  Check (-not $process.HasExited) "${label}：启动 20 秒后进程还在"
  $started = (Test-Path $log) -and (Select-String -Path $log -Pattern "DataOmni $Version" -SimpleMatch -Quiet)
  Check $started "${label}：日志里有「DataOmni $Version 启动」"
  if (Test-Path $log) { Get-Content $log | Write-Host }
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  Start-Sleep -Seconds 2
}

$machinePrograms = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
$userPrograms = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$msiLog = Join-Path $env:RUNNER_TEMP 'msi.log'

Write-Host '== MSI =='
if ($PreviousMsi) {
  Invoke-Msiexec @('/i', $PreviousMsi, '/qn') '装上旧版'
  Invoke-Msiexec @('/i', $Msi, '/qn', '/l*v', $msiLog) '新版直接装在旧版上'
} else {
  Invoke-Msiexec @('/i', $Msi, '/qn', '/l*v', $msiLog) '安装'
}
$entries = Get-UninstallEntries
Check ($entries.Count -eq 1) "「应用」里只有一个 DataOmni（实际 $($entries.Count) 个）"
Check ($entries.Count -ge 1 -and $entries[0].DisplayVersion -like "$Version*") "版本是 $Version（实际 $($entries | ForEach-Object DisplayVersion)）"
$msiDir = Join-Path $env:ProgramFiles 'DataOmni'
Check ($null -ne (Find-Shortcut $machinePrograms)) '开始菜单有快捷方式'
Test-Launch $msiDir 'MSI'
Invoke-Msiexec @('/x', $Msi, '/qn') '卸载'
Check ((Get-UninstallEntries).Count -eq 0) '卸载后「应用」里没有 DataOmni'
Check ($null -eq (Find-AppExe $msiDir)) '卸载后主程序没了'
Check ($null -eq (Find-Shortcut $machinePrograms)) '卸载后开始菜单没了'

Write-Host '== NSIS =='
$process = Start-Process $Nsis -ArgumentList '/S' -Wait -PassThru
Check ($process.ExitCode -eq 0) "安装（退出码 $($process.ExitCode)）"
$entries = Get-UninstallEntries
Check ($entries.Count -eq 1) "「应用」里只有一个 DataOmni（实际 $($entries.Count) 个）"
$nsisDir = @((Join-Path $env:LOCALAPPDATA 'DataOmni'), (Join-Path $env:ProgramFiles 'DataOmni')) |
  Where-Object { $null -ne (Find-AppExe $_) } | Select-Object -First 1
Write-Host "NSIS 装在：$nsisDir"
Check ($null -ne $nsisDir) 'NSIS 装出了主程序'
Check ($null -ne (Find-Shortcut $userPrograms) -or $null -ne (Find-Shortcut $machinePrograms)) '开始菜单有快捷方式'
if ($nsisDir) {
  Test-Launch $nsisDir 'NSIS'
  $uninstaller = Join-Path $nsisDir 'uninstall.exe'
  Check (Test-Path $uninstaller) '有 uninstall.exe'
  if (Test-Path $uninstaller) {
    Start-Process $uninstaller -ArgumentList '/S' -Wait
    # NSIS 的卸载程序把自己拷到临时目录再跑，上面的 -Wait 等不到它做完
    for ($i = 0; $i -lt 30 -and (Get-UninstallEntries).Count -gt 0; $i++) { Start-Sleep -Seconds 2 }
    Check ((Get-UninstallEntries).Count -eq 0) '卸载后「应用」里没有 DataOmni'
    Check ($null -eq (Find-AppExe $nsisDir)) '卸载后主程序没了'
  }
}

# 用户数据留不留都是常见做法，这里只记下是哪一种
$config = Join-Path $env:APPDATA 'com.dataomni.app'
Write-Host "卸载后用户配置目录 $config 还在：$(Test-Path $config)"

if ($failures.Count -gt 0) {
  Write-Host "`n$($failures.Count) 项不对："
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host "`n全部通过"
