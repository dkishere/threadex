$ErrorActionPreference = 'Continue'
$root = 'B:\threadex'
$cfDir = Join-Path $root 'cloudflared'
$dockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
if (-not (Test-Path -LiteralPath $dockerDesktop)) { $dockerDesktop = $null }
$dockerReady = $false
try { docker info --format '{{.ServerVersion}}' *> $null; $dockerReady = ($LASTEXITCODE -eq 0) } catch { }
if (-not $dockerReady -and $dockerDesktop) {
  Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
  for ($i=0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try { docker info --format '{{.ServerVersion}}' *> $null; if ($LASTEXITCODE -eq 0) { $dockerReady = $true; break } } catch { }
  }
}
$codeListening = Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue
if (-not $codeListening) {
  $code = 'C:\Users\dkish\AppData\Roaming\npm\code-server.cmd'
  if (Test-Path -LiteralPath $code) {
    Start-Process -FilePath $code -ArgumentList @('--bind-addr','127.0.0.1:8790','--auth','password','--disable-telemetry','--disable-update-check','--disable-workspace-trust','--user-data-dir','B:\threadex\data\code-server\user-data','--extensions-dir','B:\threadex\data\code-server\extensions') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $cfDir 'code-server.log') -RedirectStandardError (Join-Path $cfDir 'code-server.err.log')
  }
}
$uiListening = Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue
$apiListening = Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue
if (-not ($uiListening -and $apiListening)) {
  $env:__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = 'threadex.dimbreak.com'
  $env:WEB_VSCODE_AUTOSTART = 'false'
  $env:DOCKER_CLIENT_TIMEOUT = '30'
  Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','dev') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'threadex-dev.log') -RedirectStandardError (Join-Path $root 'threadex-dev.err.log')
}
