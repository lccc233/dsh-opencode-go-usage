# Final proof of independence: boot the DESKTOP profile's own configuration from
# a copy of the DSH home, with the workspace plugin copy renamed away, so the
# only resolvable plugin is the relocated one under ~/.dsh/plugins.
#
# The throwaway home is a copy, so the real ~/.dsh is never booted or modified.
$ErrorActionPreference = 'Continue'
$workspace = (Get-Location).Path
$root = Join-Path $workspace '.desktop-independence'
$testHome = Join-Path $root 'home'
$realHome = 'C:\Users\Administrator\.dsh'
$relocated = 'C:\Users\Administrator\.dsh\plugins\dsh-opencode-go-usage'
$workspaceCopy = Join-Path $workspace 'dsh-opencode-go-usage'
$workspaceHidden = Join-Path $root 'workspace-plugin-hidden'
$port = 19430
$failures = @()

if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
New-Item -ItemType Directory -Force -Path $testHome | Out-Null

# 1. Take the REAL desktop profile as-is (it points at ~/.dsh/plugins now), but
#    under a non-reserved name: the CLI refuses `--profile desktop` because the
#    Electron application owns that name. The row and the dependency are the
#    same bytes either way.
$verifyName = 'verify'
New-Item -ItemType Directory -Force -Path (Join-Path $testHome 'profiles') | Out-Null
Copy-Item (Join-Path $realHome 'profiles\desktop') (Join-Path $testHome "profiles\$verifyName") -Recurse -Force
Copy-Item (Join-Path $realHome '.credentials.yaml') (Join-Path $testHome '.credentials.yaml') -Force
$copiedManifest = Join-Path $testHome "profiles\$verifyName\package.json"
node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));j.name='dsh-profile-verify';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');" $copiedManifest
Write-Output '--- the copied profile manifest ---'
Get-Content $copiedManifest -Raw

# 2. Hide the workspace copy, so nothing can resolve it any more.
Move-Item -LiteralPath $workspaceCopy -Destination $workspaceHidden -Force
Write-Output "workspace plugin copy hidden: $(-not (Test-Path $workspaceCopy))"

$exe = 'D:\DSH\DeepSeek Harness.exe'
$cli = 'D:\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = $testHome
$bootOut = Join-Path $root 'boot.out'
$bootErr = Join-Path $root 'boot.err'
$hostProc = $null

try {
  $hostProc = Start-Process -FilePath $exe -ArgumentList $cli, '--profile', $verifyName, '--no-open', '--port', "$port" -WorkingDirectory $workspace -PassThru -NoNewWindow -RedirectStandardOutput $bootOut -RedirectStandardError $bootErr

  $token = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $line = Select-String -Path $bootOut -Pattern 'token=([A-Za-z0-9_\-]+)' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line) { $token = $line.Matches[0].Groups[1].Value; break }
    if ($hostProc.HasExited) { break }
  }
  Write-Output "desktop profile booted (with the workspace copy absent): $($null -ne $token)"
  if (-not $token) {
    $failures += 'the desktop profile did not boot'
    Write-Output '--- boot.out (first 12) ---'
    Get-Content $bootOut -ErrorAction SilentlyContinue | Select-Object -First 12 | ForEach-Object { Write-Output "  $_" }
    Write-Output '--- boot.err (first 25) ---'
    Get-Content $bootErr -ErrorAction SilentlyContinue | Select-Object -First 25 | ForEach-Object { Write-Output "  $_" }
  }

  $probe = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/opencode-go-usage/snapshot/probe" -TimeoutSec 40
  $probeJson = $probe.Content | ConvertFrom-Json
  Write-Output "probe: $($probe.StatusCode) plugin=$($probeJson.plugin)"
  if ($probeJson.plugin -ne 'dsh-opencode-go-usage') { $failures += 'the probe did not identify the plugin' }

  $snapshot = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/opencode-go-usage/snapshot" -TimeoutSec 60
  $data = $snapshot.Content | ConvertFrom-Json
  Write-Output "snapshot: ok=$($data.ok) rolling=$($data.windows.rolling.percent)% weekly=$($data.windows.weekly.percent)% monthly=$($data.windows.monthly.percent)%"
  if (-not $data.ok) { $failures += 'the snapshot route reported an error' }

  if ($token) {
    $index = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/?token=$token" -TimeoutSec 40 -SessionVariable session
    $inGraph = $index.Content.Contains('dsh-opencode-go-usage')
    Write-Output "boot graph carries the client bundle: $inGraph"
    if (-not $inGraph) { $failures += 'the client bundle is not in the boot graph' }
  }

  Write-Output '--- host diagnostics (filtered) ---'
  $diag = Get-Content $bootErr -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch 'crashpad|DeprecationWarning|trace-deprecation|CreateFile' }
  if ($diag) { $diag | Select-Object -First 10 } else { Write-Output '(none)' }
  if ($diag -match 'failed to import') { $failures += 'the entry failed to import' }
} catch {
  $failures += "a check threw: $($_.Exception.Message)"
  Write-Output '--- boot.err (first 25) ---'
  Get-Content $bootErr -ErrorAction SilentlyContinue | Select-Object -First 25 | ForEach-Object { Write-Output "  $_" }
} finally {
  if ($hostProc -is [System.Diagnostics.Process] -and -not $hostProc.HasExited) {
    Stop-Process -Id $hostProc.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  # Always restore the workspace copy.
  if (Test-Path $workspaceHidden) { Move-Item -LiteralPath $workspaceHidden -Destination $workspaceCopy -Force }
  Write-Output "workspace plugin copy restored: $(Test-Path $workspaceCopy)"
  if (-not $KeepRoot -and (Test-Path $root)) { Remove-Item -LiteralPath $root -Recurse -Force }
}

if ($failures.Count -gt 0) {
  Write-Output 'RESULT: FAILED'
  $failures | ForEach-Object { Write-Output "  - $_" }
  exit 1
}
Write-Output 'RESULT: PASSED (the desktop profile runs the relocated plugin without the workspace)'
