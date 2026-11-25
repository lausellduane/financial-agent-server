# Harness for local-builder.ps1 guard fixes. Run: pwsh -File .github/scripts/local-builder.tests.ps1
# Loads only the functions from local-builder.ps1 (via AST), so no job state is needed.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'local-builder.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
$wanted = 'Get-NormalizedPath', 'Test-SafeRelPath', 'Test-AiderArtifact', 'Test-ForbiddenPath', 'Get-BaseRef', 'Get-ChangedFiles'
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  if ($wanted -contains $f.Name) { . ([scriptblock]::Create($f.Extent.Text)) }
}

$fails = 0
function Check($name, $ok) {
  if ($ok) { Write-Host "ok   $name" } else { Write-Host "FAIL $name"; $script:fails++ }
}
function Invoke-TestGit { & git @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $args failed" } }

# 1. Forbidden-path guard
foreach ($p in '.github/x', '.git/config', '.env', '.dev.vars', './.github/x') {
  Check "forbidden: $p" (Test-ForbiddenPath $p)
}
Check 'unsafe: ../escape.ts' (-not (Test-SafeRelPath '../escape.ts'))
Check 'unsafe: .git/config' (-not (Test-SafeRelPath '.git/config'))
Check 'normalize: ./src/a.ts' ((Get-NormalizedPath './src/a.ts') -eq 'src/a.ts')
Check 'normalize keeps dot: .github/x' ((Get-NormalizedPath '.github/x') -eq '.github/x')
Check 'allowed: ./src/a.ts' ((Test-SafeRelPath './src/a.ts') -and -not (Test-ForbiddenPath './src/a.ts'))

# 2. Hooks and token during commit
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lb-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  Push-Location $tmp
  Invoke-TestGit init -q -b master
  Invoke-TestGit config user.email t@example.com
  Invoke-TestGit config user.name t
  Set-Content a.txt 'base'
  Invoke-TestGit add a.txt
  Invoke-TestGit commit -q -m base
  $base = (git rev-parse HEAD).Trim()
  $leak = Join-Path $tmp 'leak.txt'
  Set-Content (Join-Path $tmp '.git/hooks/pre-commit') "#!/bin/sh`necho `$GH_TOKEN > '$leak'`n"
  if ($IsLinux -or $IsMacOS) { chmod +x (Join-Path $tmp '.git/hooks/pre-commit') }
  Set-Content b.txt 'x'
  Invoke-TestGit add b.txt
  $env:GH_TOKEN = 'secret'
  $saved = $env:GH_TOKEN
  Remove-Item Env:GH_TOKEN
  Check 'GH_TOKEN absent during commit' (-not $env:GH_TOKEN)
  git -c core.hooksPath=NUL commit --no-verify -q -m t 2>&1 | Out-Null
  $env:GH_TOKEN = $saved
  Check 'commit succeeded' ($LASTEXITCODE -eq 0)
  Check 'pre-commit hook did not run' (-not (Test-Path $leak))
  Remove-Item Env:GH_TOKEN
  Remove-Item (Join-Path $tmp '.git/hooks/pre-commit') -Force   # later setup commits must not run it

  # 5/6. Base ref: local master behind origin/master, existing branch recreated
  Invoke-TestGit checkout -q -b local-builder/issue-1
  Invoke-TestGit checkout -q master
  Set-Content c.txt 'upstream'
  Invoke-TestGit add c.txt
  Invoke-TestGit commit -q -m upstream
  $fresh = (git rev-parse HEAD).Trim()
  Invoke-TestGit checkout -q local-builder/issue-1
  Invoke-TestGit branch -q -f master $base            # local master is stale
  Invoke-TestGit checkout -q -B local-builder/issue-1 $fresh   # relabel retry recreates the branch
  Check 'existing branch recreated from fresh base' ((git rev-parse HEAD).Trim() -eq $fresh)
  Set-Content d.txt 'agent'
  $env:GITHUB_WORKSPACE = $tmp
  $env:LOCAL_BUILDER_BASE = $fresh
  $changed = @(Get-ChangedFiles)
  Check 'only agent changes vs branch base' (($changed -join ',') -eq 'd.txt')
  $stale = @(Get-ChangedFiles -BaseRef 'master')
  Check 'stale local master would have leaked c.txt' ($stale -contains 'c.txt')
  Remove-Item Env:LOCAL_BUILDER_BASE
} finally {
  Pop-Location
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# 3. Every step in local-builder.yml has timeout-minutes; non-Aider steps use 10 or less
$workflow = Join-Path $PSScriptRoot '..\workflows\local-builder.yml'
$steps = @()
$current = $null
foreach ($line in (Get-Content -LiteralPath $workflow -Encoding UTF8)) {
  if ($line -match '^      - name: (.+)$') {
    $current = [pscustomobject]@{ Name = $Matches[1].Trim(); Lines = @() }
    $steps += $current
  } elseif ($current -and $line -match '^        \S') {
    $current.Lines += $line
  }
}
Check 'workflow has steps' ($steps.Count -gt 10)
foreach ($s in $steps) {
  $t = $s.Lines | Where-Object { $_ -match '^        timeout-minutes:\s*(\d+)\s*$' } | Select-Object -First 1
  $minutes = if ($t -and $t -match '(\d+)') { [int]$Matches[1] } else { 0 }
  Check "timeout-minutes set: $($s.Name)" ($minutes -gt 0)
  if ($s.Name -notlike 'Aider attempt*') {
    Check "timeout-minutes <= 10: $($s.Name)" ($minutes -gt 0 -and $minutes -le 10)
  }
}

# 4. Attempt 2 after a timed-out (cancelled) attempt 1
$evalStep = $steps | Where-Object { $_.Name -eq 'Evaluate attempt 1' }
$evalIf = ($evalStep.Lines | Where-Object { $_ -match '^        if:' }) -join ' '
foreach ($o in 'success', 'failure', 'cancelled') {
  Check "evaluate runs when attempt 1 is $o" ($evalIf -match "steps\.aider1\.outcome == '$o'")
}
$a2Step = $steps | Where-Object { $_.Name -eq 'Aider attempt 2' }
Check 'attempt 2 gated on NEED_ATTEMPT_2' ((($a2Step.Lines | Where-Object { $_ -match '^        if:' }) -join ' ') -match "env\.NEED_ATTEMPT_2 == 'true'")

# Run the evaluate step as attempt 1 leaves it after a timeout: no diff, then with BLOCKED.md.
$shell = (Get-Process -Id $PID).Path
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lb-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
$savedEnv = @{ GITHUB_WORKSPACE = $env:GITHUB_WORKSPACE; RUNNER_TEMP = $env:RUNNER_TEMP; GITHUB_ENV = $env:GITHUB_ENV; LOCAL_BUILDER_BASE = $env:LOCAL_BUILDER_BASE }
try {
  $ws = Join-Path $tmp 'ws'
  $rt = Join-Path $tmp 'rt'
  New-Item -ItemType Directory $ws, $rt | Out-Null
  Push-Location $ws
  Invoke-TestGit init -q -b master
  Invoke-TestGit config user.email t@example.com
  Invoke-TestGit config user.name t
  Set-Content a.txt 'base'
  Invoke-TestGit add a.txt
  Invoke-TestGit commit -q -m base
  $env:LOCAL_BUILDER_BASE = (git rev-parse HEAD).Trim()
  Pop-Location
  $env:GITHUB_WORKSPACE = $ws
  $env:RUNNER_TEMP = $rt

  $env:GITHUB_ENV = Join-Path $rt 'env-timeout.txt'
  & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Step evaluate | Out-Null
  $code = $LASTEXITCODE
  $out = if (Test-Path $env:GITHUB_ENV) { Get-Content -Raw $env:GITHUB_ENV } else { '' }
  Check 'cancelled attempt 1, no diff: evaluate succeeds' ($code -eq 0)
  Check 'cancelled attempt 1, no diff: attempt 2 scheduled' ($out -match '(?m)^NEED_ATTEMPT_2=true\s*$')

  Set-Content (Join-Path $ws 'BLOCKED.md') 'cannot continue'
  $env:GITHUB_ENV = Join-Path $rt 'env-blocked.txt'
  & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Step evaluate | Out-Null
  $code = $LASTEXITCODE
  $out = if (Test-Path $env:GITHUB_ENV) { Get-Content -Raw $env:GITHUB_ENV } else { '' }
  Check 'BLOCKED.md: evaluate fails the job' ($code -ne 0)
  Check 'BLOCKED.md: attempt 2 skipped' (($out -match '(?m)^NEED_ATTEMPT_2=false\s*$') -and ($out -notmatch 'NEED_ATTEMPT_2=true'))
} finally {
  foreach ($k in $savedEnv.Keys) { Set-Item -Path "Env:$k" -Value $savedEnv[$k] -ErrorAction SilentlyContinue; if (-not $savedEnv[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue } }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if ($fails -gt 0) { Write-Host "$fails check(s) failed"; exit 1 }
Write-Host 'all checks passed'
