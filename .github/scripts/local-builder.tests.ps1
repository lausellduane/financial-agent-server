# Harness for local-builder.ps1 guard fixes. Run: pwsh -File .github/scripts/local-builder.tests.ps1
# Loads only the functions from local-builder.ps1 (via AST), so no job state is needed.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'local-builder.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
$wanted = 'Get-NormalizedPath', 'Test-SafeRelPath', 'Test-AiderArtifact', 'Test-ForbiddenPath', 'Get-BaseRef', 'Get-ChangedFiles',
  'Get-GitIntegrity', 'Invoke-PublishGit', 'Get-PublishPushArgs', 'Get-RemoteBranchSha', 'Publish-PullRequest'
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  if ($wanted -contains $f.Name) { . ([scriptblock]::Create($f.Extent.Text)) }
}

$fails = 0
function Check($name, $ok) {
  if ($ok) { Write-Host "ok   $name" } else { Write-Host "FAIL $name"; $script:fails++ }
}
function Invoke-TestGit { $ErrorActionPreference = 'Continue'; & git @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $args failed" } }
# Plain git, for showing an attack works without the fix. Returns the exit code.
function Invoke-RawGit { $ErrorActionPreference = 'Continue'; & git @args 2>&1 | Out-Null; return $LASTEXITCODE }

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

# Review follow-up: publish git calls, .git integrity, lease-guarded push, PR reuse.
# Each attack is first shown to work without the fix, so the checks cannot pass vacuously.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lb-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
$savedEnv = @{}
foreach ($k in 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_GLOBAL') { $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }
try {
  $ws = Join-Path $tmp 'ws'
  $remote = (Join-Path $tmp 'remote.git') -replace '\\', '/'
  New-Item -ItemType Directory $ws | Out-Null
  Invoke-TestGit init -q --bare $remote
  Push-Location $ws
  Invoke-TestGit init -q -b master
  Invoke-TestGit config user.email t@example.com
  Invoke-TestGit config user.name t
  Set-Content a.txt 'base'
  Invoke-TestGit add a.txt
  Invoke-TestGit commit -q -m base
  $base = (git rev-parse HEAD).Trim()
  # An unrelated history on the remote issue branch, as a previous run would leave.
  Invoke-TestGit checkout -q --orphan old
  Set-Content a.txt 'old run'
  Invoke-TestGit add a.txt
  Invoke-TestGit commit -q -m old
  $oldSha = (git rev-parse HEAD).Trim()
  Invoke-TestGit push -q $remote HEAD:refs/heads/local-builder/issue-7
  Invoke-TestGit checkout -q -f master
  Set-Content b.txt 'agent'

  # .git integrity snapshot
  $snap = Get-GitIntegrity -Workspace $ws
  Check 'integrity: unchanged repo matches snapshot' ((Get-GitIntegrity -Workspace $ws) -eq $snap)
  $leakDir = $tmp -replace '\\', '/'
  $hook = "#!/bin/sh`nenv > '$leakDir/leak-hook.txt'`n"
  foreach ($h in 'pre-commit', 'pre-push', 'post-commit', 'reference-transaction') { Set-Content (Join-Path $ws ".git/hooks/$h") $hook -NoNewline }
  Check 'integrity: planted hook detected' ((Get-GitIntegrity -Workspace $ws) -ne $snap)
  Invoke-TestGit config core.fsmonitor "env > '$leakDir/leak-fsmonitor.txt'; true"
  $global = Join-Path $tmp 'evil.gitconfig'
  Set-Content $global "[core]`n`tfsmonitor = env > '$leakDir/leak-global.txt'; true`n[credential]`n`thelper = !env > '$leakDir/leak-cred.txt'; true`n"

  # Without the wrapper the planted fsmonitor and global config do run.
  Invoke-RawGit status | Out-Null
  Check 'attack check: local fsmonitor runs on plain git' (Test-Path (Join-Path $tmp 'leak-fsmonitor.txt'))
  $env:GIT_CONFIG_GLOBAL = $global
  Invoke-TestGit config --unset core.fsmonitor
  Invoke-RawGit status | Out-Null
  Invoke-TestGit config core.fsmonitor "env > '$leakDir/leak-fsmonitor.txt'; true"
  Check 'attack check: global fsmonitor runs on plain git' (Test-Path (Join-Path $tmp 'leak-global.txt'))
  Invoke-RawGit -c user.name=x -c user.email=x@example.com commit -q --allow-empty -m probe | Out-Null
  Check 'attack check: planted hooks run on a plain commit' (Test-Path (Join-Path $tmp 'leak-hook.txt'))
  Invoke-TestGit reset -q --soft HEAD~1
  Remove-Item (Join-Path $tmp 'leak-*.txt') -Force -ErrorAction SilentlyContinue
  Check 'integrity: planted fsmonitor detected' ((Get-GitIntegrity -Workspace $ws) -ne $snap)

  # Publish-style add, commit, and push through Invoke-PublishGit, with tokens set.
  $env:GH_TOKEN = 'secret-gh'
  $env:GITHUB_TOKEN = 'secret-github'
  $r1 = Invoke-PublishGit -GitArgs @('add', '--', 'b.txt')
  $r2 = Invoke-PublishGit -GitArgs @('-c', 'user.name=bot', '-c', 'user.email=bot@example.com', 'commit', '--no-verify', '-m', 'agent')
  $head = (git rev-parse HEAD).Trim()
  Check 'publish git: add and commit succeed' ($r1.ExitCode -eq 0 -and $r2.ExitCode -eq 0 -and $head -ne $base)
  $dump = Invoke-PublishGit -GitArgs @('-c', 'alias.envdump=!env', 'envdump')
  Check 'publish git: no token in the git environment' ($dump.ExitCode -eq 0 -and $dump.Output -notmatch 'secret-' -and $dump.Output -match 'PATH')
  $hdr = Invoke-PublishGit -GitArgs @('config', '--get', 'http.https://github.com/.extraheader') -AuthHeader 'AUTHORIZATION: bearer t'
  Check 'publish git: auth header reaches git' ($hdr.Output.Trim() -eq 'AUTHORIZATION: bearer t')
  Check 'publish git: auth header never written to .git/config' (-not (Select-String -Path (Join-Path $ws '.git/config') -Pattern 'extraheader' -Quiet))

  # Lease-guarded push of the issue branch
  $plainExit = Invoke-RawGit -c core.hooksPath=NUL push $remote HEAD:refs/heads/local-builder/issue-7
  Check 'attack check: plain push over an old run branch is rejected' ($plainExit -ne 0)
  $seen = Get-RemoteBranchSha -RemoteUrl $remote -Branch 'local-builder/issue-7'
  Check 'ls-remote reads the existing branch' ($seen -eq $oldSha)
  $stale = Invoke-PublishGit -GitArgs (Get-PublishPushArgs -RemoteUrl $remote -Branch 'local-builder/issue-7' -ExpectedSha $base)
  Check 'lease: push refused when the branch moved' ($stale.ExitCode -ne 0)
  $ok = Invoke-PublishGit -GitArgs (Get-PublishPushArgs -RemoteUrl $remote -Branch 'local-builder/issue-7' -ExpectedSha $seen) -AuthHeader 'AUTHORIZATION: bearer t'
  Check 'lease: relabel retry replaces the old branch' ($ok.ExitCode -eq 0 -and (Get-RemoteBranchSha -RemoteUrl $remote -Branch 'local-builder/issue-7') -eq $head)
  Check 'lease: missing branch reads as empty' ((Get-RemoteBranchSha -RemoteUrl $remote -Branch 'local-builder/issue-8') -eq '')
  $new = Invoke-PublishGit -GitArgs (Get-PublishPushArgs -RemoteUrl $remote -Branch 'local-builder/issue-8' -ExpectedSha '')
  Check 'lease: new branch is created' ($new.ExitCode -eq 0)
  $r3 = Invoke-PublishGit -GitArgs @('-c', 'user.name=bot', '-c', 'user.email=bot@example.com', 'commit', '--allow-empty', '--no-verify', '-m', 'second run')
  $again = Invoke-PublishGit -GitArgs (Get-PublishPushArgs -RemoteUrl $remote -Branch 'local-builder/issue-8' -ExpectedSha '')
  Check 'lease: expect-absent push refused once the branch exists' ($again.ExitCode -ne 0)
  foreach ($b in 'master', 'main', 'local-builder/issue-7x', 'local-builder/issue-7:refs/heads/master') {
    $threw = $false
    try { Get-PublishPushArgs -RemoteUrl $remote -Branch $b -ExpectedSha '' | Out-Null } catch { $threw = $true }
    Check "push refuses branch '$b'" $threw
  }
  $pushArgs = Get-PublishPushArgs -RemoteUrl $remote -Branch 'local-builder/issue-7' -ExpectedSha $seen
  Check 'push targets only the issue branch' ((($pushArgs | Where-Object { $_ -match 'refs/heads/' }) -join ' ') -notmatch 'master')

  $leaks = @(Get-ChildItem $tmp -Filter 'leak-*.txt')
  Check 'no hook or fsmonitor ran during publish git' ($leaks.Count -eq 0)
  Check 'tokens restored after publish git' ($env:GH_TOKEN -eq 'secret-gh' -and $env:GITHUB_TOKEN -eq 'secret-github' -and $env:GIT_CONFIG_GLOBAL -eq $global)
  Pop-Location
} finally {
  if ((Get-Location).Path -ne $PSScriptRoot -and (Get-Location).Path -like "$tmp*") { Pop-Location }
  foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], 'Process') }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# Open PR reuse on a relabel retry (Invoke-GitHub is replaced with a recorder)
$script:ghCalls = @()
$script:openPrs = @()
function Invoke-GitHub { param([string]$Method, [string]$Uri, [string]$Body)
  $script:ghCalls += [pscustomobject]@{ Method = $Method; Uri = $Uri; Body = $Body }
  if ($Method -eq 'GET') { return $script:openPrs }
  return [pscustomobject]@{ number = 99; html_url = 'x' }
}
Publish-PullRequest -Repo 'o/r' -Branch 'local-builder/issue-7' -Title 't' -Body 'b' | Out-Null
Check 'PR: opens a new PR when none is open' (($script:ghCalls | Where-Object Method -eq 'POST').Uri -like '*/repos/o/r/pulls' -and (($script:ghCalls | Where-Object Method -eq 'POST').Body | ConvertFrom-Json).base -eq 'master')
$script:ghCalls = @()
$script:openPrs = @([pscustomobject]@{ number = 12 })
Publish-PullRequest -Repo 'o/r' -Branch 'local-builder/issue-7' -Title 't' -Body 'b' | Out-Null
Check 'PR: reuses the open PR on a relabel retry' ((@($script:ghCalls | Where-Object Method -eq 'POST').Count -eq 0) -and (($script:ghCalls | Where-Object Method -eq 'PATCH').Uri -like '*/pulls/12'))
Check 'PR: looks up open PRs by owner:branch' (($script:ghCalls | Where-Object Method -eq 'GET').Uri -like '*head=o:local-builder/issue-7*')

if ($fails -gt 0) { Write-Host "$fails check(s) failed"; exit 1 }
Write-Host 'all checks passed'
