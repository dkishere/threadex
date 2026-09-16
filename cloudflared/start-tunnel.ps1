$ErrorActionPreference = 'Stop'
$exe = (Get-Command cloudflared -ErrorAction Stop).Source
$config = 'B:\threadex\cloudflared\config.yml'
$running = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "threadex-local" }
if ($running) { exit 0 }
Start-Process -FilePath $exe -ArgumentList @('--config',$config,'tunnel','run','threadex-local') -WorkingDirectory 'B:\threadex' -WindowStyle Hidden -RedirectStandardOutput 'B:\threadex\cloudflared\cloudflared.log' -RedirectStandardError 'B:\threadex\cloudflared\cloudflared.err.log'

