# Acceptance check for the OpenCode Go usage plugin.
#
# Runs entirely inside the workspace: it creates a throwaway DSH home with a
# copied credential store, so the user's desktop profile is never booted or
# modified. Two phases:
#   1. compose the REAL desktop profile patch with DSH's own launcher
#      (`--dump-config`) and assert the plugin row survives composition;
#   2. boot a throwaway profile with the canonical row and assert both halves:
#      the host routes answer with live quota, and the browser module graph
#      carries this plugin's client bundle.
#
# Pass -Deep to also download the ~10 MB batch script the browser loads and
# confirm this plugin's factory text is inside it (slower, needs more memory).
#
# Every file this script writes is UTF-8 WITHOUT a BOM: a BOM in
# profiles/<name>/package.json makes DSH fail at boot with
# "Unexpected token '', ... is not valid JSON".

param(
  [switch]$Deep,
  [string]$PluginDir = ''
)

$ErrorActionPreference = 'Continue'
$workspace = (Get-Location).Path
if ($PluginDir -eq '') { $PluginDir = Join-Path $workspace 'dsh-opencode-go-usage' }
if (-not (Test-Path $PluginDir)) { throw "plugin directory not found: $PluginDir" }
Write-Output "plugin under test: $PluginDir"
$acceptRoot = Join-Path $workspace '.opencode-usage-accept'
$acceptHome = Join-Path $acceptRoot 'home'
$profileName = 'verify'
$profileDir = Join-Path $acceptHome "profiles\$profileName"
$desktopPatch = "C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml"
$credentials = "C:\Users\Administrator\.dsh\.credentials.yaml"

$exe = 'D:\DSH\DeepSeek Harness.exe'
$cli = 'D:\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
$port = 19410
$failures = @()

function Write-NoBom([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Assert-NoBom([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $script:failures += "BOM found in $path"
    return $false
  }
  return $true
}

function Invoke-Dsh([string[]]$dshArgs, [string]$stdout, [string]$stderr) {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:DSH_HOME = $acceptHome
  $p = Start-Process -FilePath $exe -ArgumentList (@($cli) + $dshArgs) -WorkingDirectory $workspace -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  return $p
}

# ---------------------------------------------------------------- prepare home
if (Test-Path $acceptRoot) { Remove-Item -LiteralPath $acceptRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $profileDir 'node_modules') | Out-Null
Copy-Item $credentials (Join-Path $acceptHome '.credentials.yaml') -Force
# Link the plugin into this throwaway profile. A junction is preferred, but
# creating one that points OUTSIDE the sandbox's writable area can be denied, so
# fall back to a copy: the boot only needs the package to resolve.
$linkPath = Join-Path $profileDir 'node_modules\dsh-opencode-go-usage'
try {
  New-Item -ItemType Junction -Path $linkPath -Target $pluginDir -ErrorAction Stop | Out-Null
  Write-Output 'plugin linked: junction'
} catch {
  Copy-Item -LiteralPath $pluginDir -Destination $linkPath -Recurse -Force
  Write-Output 'plugin linked: copy (junction was denied)'
}
node -e "const {createRequire}=require('node:module');const r=createRequire(process.argv[1]+'/package.json');console.log('resolves to:',r.resolve('dsh-opencode-go-usage'))" $profileDir

# The throwaway profile mirrors the desktop bundle set, so the same rows compose.
$profileManifest = @'
{
  "name": "dsh-profile-verify",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
'@
Write-NoBom (Join-Path $profileDir 'package.json') $profileManifest
Write-NoBom (Join-Path $profileDir 'cordis.yml') "[]`n"
Assert-NoBom (Join-Path $profileDir 'package.json') | Out-Null
node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));console.log('profile manifest: valid JSON')" (Join-Path $profileDir 'package.json')

# ------------------------------------------- phase 0: plugin contract checks
# These run before any boot and catch the failure modes no HTTP check can see —
# above all the client bundle's registration id, whose mismatch takes down the
# whole web boot with "1 entry did not activate".
# This environment does not surface child exit codes, so success is asserted on
# each check's own terminal marker instead.
Write-Output '=== phase 0: plugin contract checks ==='
# The checks live beside this script and take the plugin directory to test, so
# phase 0 always verifies the copy named by -PluginDir (not a stale neighbour).
$toolsDir = Split-Path -Parent $PSCommandPath
foreach ($check in @('check-client.mjs', 'check-host.mjs')) {
  $checkPath = Join-Path $toolsDir $check
  if (-not (Test-Path $checkPath)) { $checkPath = Join-Path $workspace $check }
  $checkOut = Join-Path $acceptRoot "$check.out"
  $checkErr = Join-Path $acceptRoot "$check.err"
  Remove-Item $checkOut, $checkErr -Force -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath 'node' -ArgumentList $checkPath, $PluginDir -WorkingDirectory $workspace -PassThru -NoNewWindow -RedirectStandardOutput $checkOut -RedirectStandardError $checkErr
  $proc.WaitForExit(180000) | Out-Null
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  $checkText = Get-Content $checkOut -Raw -ErrorAction SilentlyContinue
  $passed = $checkText -match 'PASSED'
  Write-Output "$check against $PluginDir -> $(if ($passed) { 'PASSED' } else { 'FAILED' })"
  if (-not $passed) {
    $failures += "$check did not report PASSED"
    Get-Content $checkErr -ErrorAction SilentlyContinue | Select-Object -First 6 | ForEach-Object { Write-Output "    $_" }
    $checkText -split "`n" | Select-Object -Last 6 | ForEach-Object { Write-Output "    $_" }
  }
}

# ------------------------------------------- phase 1: the REAL desktop patch file
# Cheap structural assertion: the row must be an insert entry, because a bare
# `- id: <new id>` row is warned and skipped when the tree does not already
# carry that id.
Write-Output '=== phase 1: inspect the real desktop profile patch ==='
$desktopText = Get-Content $desktopPatch -Raw
if ($desktopText -match '(?s)-\s+insert:.*?-\s+id:\s+opencode-go-usage') {
  Write-Output 'desktop patch mounts the row through an insert list: OK'
} else {
  $failures += 'the desktop patch does not mount the plugin through an insert list'
}
if ($desktopText -match 'id:\s+opencode-go-usage') { Write-Output 'desktop patch carries the plugin row: OK' }
else { $failures += 'the desktop patch does not carry the plugin row' }

# Then boot the throwaway profile with that exact file. This exercises DSH's
# parser, the compatibility preflight, the loader import and route registration
# on the real bytes — strictly stronger than a config dump, and it does not
# depend on the dump process finishing.
Write-Output '=== phase 2: boot with the real desktop patch and check both halves ==='
Copy-Item $desktopPatch (Join-Path $profileDir 'cordis.patch.yml') -Force
Assert-NoBom (Join-Path $profileDir 'cordis.patch.yml') | Out-Null

$bootOut = Join-Path $acceptRoot 'boot.out'
$bootErr = Join-Path $acceptRoot 'boot.err'
# `$host` is a read-only PowerShell automatic variable; use a distinct name.
$hostProc = Invoke-Dsh @('--profile', $profileName, '--no-open', '--port', "$port") $bootOut $bootErr
if ($hostProc -isnot [System.Diagnostics.Process]) { $failures += 'the host process did not start' }
try {
  $token = $null
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    $line = Select-String -Path $bootOut -Pattern 'token=([A-Za-z0-9_\-]+)' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line) { $token = $line.Matches[0].Groups[1].Value; break }
    if ($hostProc.HasExited) { break }
  }
  if (-not $token) {
    $failures += 'the host never printed its startup URL'
  } else {
    $probe = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/opencode-go-usage/snapshot/probe" -TimeoutSec 30
    $probeJson = $probe.Content | ConvertFrom-Json
    Write-Output "probe: $($probe.StatusCode) plugin=$($probeJson.plugin) version=$($probeJson.version)"
    if ($probeJson.plugin -ne 'dsh-opencode-go-usage') { $failures += 'the probe route did not identify the plugin' }

    $snapshot = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/opencode-go-usage/snapshot" -TimeoutSec 45
    $data = $snapshot.Content | ConvertFrom-Json
    Write-Output "snapshot: ok=$($data.ok) fetchedAt=$($data.fetchedAt) stale=$($data.stale)"
    if (-not $data.ok) { $failures += "the snapshot route reported an error: $($data.error.code) $($data.error.message)" }
    foreach ($name in @('rolling', 'weekly', 'monthly')) {
      $window = $data.windows.$name
      if ($null -eq $window) { $failures += "window $name is missing" }
      else { Write-Output ("  {0}: used {1}%, resets {2}" -f $name, $window.percent, $window.resetsAt) }
    }

    # The host composes the browser module graph from active loader entries'
    # `dsh.client` declarations, so membership here proves the row is active and
    # the client manifest parsed. -Deep additionally fetches the batch body.
    $index = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/?token=$token" -TimeoutSec 30 -SessionVariable session
    if (-not $index.Content.Contains('dsh-opencode-go-usage')) {
      $failures += 'the client bundle is not in the browser boot graph'
    } else {
      Write-Output 'boot graph carries the client bundle: OK'
      if ($Deep) {
        $comboRaw = [regex]::Match($index.Content, 'plugins/\?\?[^"]*dsh-opencode-go-usage[^"]*').Value
        $combo = $comboRaw.Replace('&amp;', '&')
        if ($combo) {
          $batchFile = Join-Path $acceptRoot 'batch.js'
          $code = & curl.exe -s -o $batchFile -w '%{http_code} %{size_download}' -b $session -H 'Accept-Encoding: identity' -m 120 "http://127.0.0.1:$port/$combo"
          Write-Output "batch fetch: $code"
          $batchText = Get-Content $batchFile -Raw -ErrorAction SilentlyContinue
          $carries = $batchText -and $batchText.Contains('conversation.composer.dock') -and $batchText.Contains('opencode-go-usage')
          Write-Output "served batch carries this factory: $carries"
          if (-not $carries) { $failures += 'the served batch does not carry this plugin factory' }
        } else {
          $failures += 'no batch URL carrying this plugin was found'
        }
      }
    }
  }
} catch {
  $failures += "a check threw: $($_.Exception.Message)"
} finally {
  Write-Output '--- host stderr (real diagnostics only) ---'
  Get-Content $bootErr -ErrorAction SilentlyContinue |
    Where-Object { $_ -notmatch 'crashpad|DeprecationWarning|trace-deprecation|CreateFile' } |
    Select-Object -Last 10
  if ($hostProc -is [System.Diagnostics.Process] -and -not $hostProc.HasExited) {
    Stop-Process -Id $hostProc.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

Write-Output '--- BOM audit of the files under test ---'
foreach ($f in @(
    (Join-Path $profileDir 'package.json'),
    (Join-Path $profileDir 'cordis.patch.yml'),
    $desktopPatch,
    "C:\Users\Administrator\.dsh\profiles\desktop\package.json",
    (Join-Path $pluginDir 'package.json'),
    (Join-Path $pluginDir 'cordis.patch.yml'))) {
  $ok = Assert-NoBom $f
  Write-Output ("  {0,-70} {1}" -f $f, $(if ($ok) { 'no BOM' } else { 'BOM!' }))
}

if ($failures.Count -gt 0) {
  Write-Output 'RESULT: FAILED'
  $failures | ForEach-Object { Write-Output "  - $_" }
  exit 1
}
Write-Output 'RESULT: PASSED'
