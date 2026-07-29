param(
  [ValidateSet("menu", "start", "stop", "restart", "status")]
  [string]$Action = "menu"
)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Root ".voucher-server.pid"
$LogFile = Join-Path $Root "service.log"
$ErrorLogFile = Join-Path $Root "service-error.log"
$ServerFile = Join-Path $Root "server.mjs"
$ConfigFile = Join-Path $Root "config.json"
$Config = if (Test-Path $ConfigFile) {
  try {
    Get-Content $ConfigFile -Raw | ConvertFrom-Json
  } catch {
    throw "无法读取 config.json：$($_.Exception.Message)"
  }
} else {
  [PSCustomObject]@{}
}
$Port = if ($env:PORT) { $env:PORT } elseif ($Config.port) { "$($Config.port)" } else { "3000" }

function Read-ServicePid {
  if (Test-Path $PidFile) {
    $value = (Get-Content $PidFile -Raw) -replace "\D", ""
    if ($value) { return [int]$value }
  }
  return $null
}

function Get-ServiceProcess {
  $servicePid = Read-ServicePid
  if (-not $servicePid) { return $null }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid" -ErrorAction SilentlyContinue
  if ($processInfo -and $processInfo.CommandLine -like "*server.mjs*") { return $processInfo }
  return $null
}

function Show-Addresses {
  Write-Host "电脑访问：http://localhost:$Port"
  $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress -Unique
  foreach ($address in $addresses) { Write-Host "手机访问：http://${address}:$Port" }
}

function Start-ServiceApp {
  $existing = Get-ServiceProcess
  if ($existing) {
    Write-Host "服务已经在运行，进程号：$($existing.ProcessId)"
    Show-Addresses
    return
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "没有找到 Node.js，请先安装 Node.js 18 或更高版本。"
  }
  Push-Location $Root
  try {
    node -e "require.resolve('jszip')" 2>$null
    if ($LASTEXITCODE -ne 0) {
      if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw "没有找到 npm，请重新安装 Node.js LTS。"
      }
      Write-Host "首次运行，正在自动安装依赖，请稍候……"
      & npm.cmd install
      if ($LASTEXITCODE -ne 0) { throw "依赖安装失败，请检查网络后重新运行 service.cmd。" }
    }
    $process = Start-Process -FilePath "node" -ArgumentList "`"$ServerFile`"" -WorkingDirectory $Root `
      -RedirectStandardOutput $LogFile -RedirectStandardError $ErrorLogFile -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value $process.Id -NoNewline
    Start-Sleep -Seconds 1
    if (-not (Get-ServiceProcess)) { throw "启动失败，请查看 $ErrorLogFile" }
    Write-Host "服务已启动，进程号：$($process.Id)"
    Show-Addresses
    Write-Host "运行日志：$LogFile"
  } finally {
    Pop-Location
  }
}

function Stop-ServiceApp {
  $processInfo = Get-ServiceProcess
  if (-not $processInfo) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "服务当前没有运行。"
    return
  }
  Stop-Process -Id $processInfo.ProcessId -Force
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host "服务已关闭。"
}

function Show-Status {
  $processInfo = Get-ServiceProcess
  if ($processInfo) {
    Write-Host "服务正在运行，进程号：$($processInfo.ProcessId)"
    Show-Addresses
  } else {
    Write-Host "服务当前没有运行。"
  }
}

if ($Action -eq "menu") {
  Write-Host ""
  Write-Host "================================"
  Write-Host "  凭证照片归档系统 · 服务开关"
  Write-Host "================================"
  Write-Host "  1. 启动服务"
  Write-Host "  2. 关闭服务"
  Write-Host "  3. 重启服务"
  Write-Host "  4. 查看状态"
  Write-Host "  0. 退出"
  Write-Host "================================"
  $choice = Read-Host "请选择功能 [0-4]"
  $Action = switch ($choice) {
    "1" { "start" }
    "2" { "stop" }
    "3" { "restart" }
    "4" { "status" }
    "0" { "exit" }
    default { "invalid" }
  }
}

switch ($Action) {
  "start" { Start-ServiceApp }
  "stop" { Stop-ServiceApp }
  "restart" { Stop-ServiceApp; Start-ServiceApp }
  "status" { Show-Status }
  "exit" { Write-Host "已退出，没有执行任何操作。" }
  default { Write-Host "输入无效。" }
}
