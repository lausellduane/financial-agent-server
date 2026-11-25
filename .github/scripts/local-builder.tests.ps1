# Harness for the local-builder scripts. Run on Windows: pwsh -File .github/scripts/local-builder.tests.ps1
# (Windows PowerShell 5.1 works too). Loads only functions (via AST), so no job state is needed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-builder-common.ps1')
$script = Join-Path $PSScriptRoot 'local-builder.ps1'
$publishScript = Join-Path $PSScriptRoot 'local-builder-publish.ps1'
# Inline (not a helper function), so the definitions land in this script's scope.
foreach ($pair in @(@($script, @('Get-BaseRef', 'Get-ChangedFiles', 'New-ResultArtifact')), @($publishScript, @()))) {
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($pair[0], [ref]$null, [ref]$null)
  foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($pair[1].Count -eq 0 -or $pair[1] -contains $f.Name) { . ([scriptblock]::Create($f.Extent.Text)) }
  }
}

$fails = 0
function Check($name, $ok) {
  if ($ok) { Write-Host "ok   $name" } else { Write-Host "FAIL $name"; $script:fails++ }
}
function Invoke-TestGit { $ErrorActionPreference = 'Continue'; & git @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $args failed" } }
# Plain git, for showing an attack works without the fix. Returns the exit code.
function Invoke-RawGit { $ErrorActionPreference = 'Continue'; & git @args 2>&1 | Out-Null; return $LASTEXITCODE }
function New-TestRepo([string]$Path) {
  New-Item -ItemType Directory $Path -Force | Out-Null
  Push-Location $Path
  Invoke-TestGit init -q -b master
  Invoke-TestGit config user.email t@example.com
  Invoke-TestGit config user.name t
  Pop-Location
}

# 1. Forbidden-path guard
foreach ($p in '.github/x', '.git/config', '.env', '.dev.vars', './.github/x') {
  Check "forbidden: $p" (Test-ForbiddenPath $p)
}
Check 'unsafe: ../escape.ts' (-not (Test-SafeRelPath '../escape.ts'))
Check 'unsafe: .git/config' (-not (Test-SafeRelPath '.git/config'))
Check 'normalize: ./src/a.ts' ((Get-NormalizedPath './src/a.ts') -eq 'src/a.ts')
Check 'normalize keeps dot: .github/x' ((Get-NormalizedPath '.github/x') -eq '.github/x')
Check 'allowed: ./src/a.ts' ((Test-SafeRelPath './src/a.ts') -and -not (Test-ForbiddenPath './src/a.ts'))

# Task selection is shared by build and publish
$tasksText = "## 1. X`n- [ ] 1.1 Do a`n  Files:`n  - src/a.ts`n  - src/new.ts`n- [x] 1.2 Done`n  Files: src/done.ts`n- [ ] 1.3 Bad`n  Files: .github/workflows/x.yml`n"
$sel = Resolve-ChangeSelection -TasksText $tasksText -TaskSpec '1.1' -ChangeId 'c'
Check 'selection: files from the selected task' ((($sel.Allowed | Sort-Object) -join ',') -eq 'src/a.ts,src/new.ts')
$threw = $false; try { Resolve-ChangeSelection -TasksText $tasksText -TaskSpec '1.3' -ChangeId 'c' | Out-Null } catch { $threw = $true }
Check 'selection: forbidden Files: path rejected' $threw
$threw = $false; try { Resolve-ChangeSelection -TasksText $tasksText -TaskSpec '9.9' -ChangeId 'c' | Out-Null } catch { $threw = $true }
Check 'selection: unknown task rejected' $threw

# 2. Hooks and token during commit
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lb-" + [guid]::NewGuid())
New-TestRepo $tmp
try {
  Push-Location $tmp
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

  # 5/6. Base ref: local master behind the base, existing branch recreated
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
$wfLines = @(Get-Content -LiteralPath $workflow -Encoding UTF8)
$steps = @()
$current = $null
foreach ($line in $wfLines) {
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

# Job separation: the write token never reaches the self-hosted job (split-local-builder-publish-job)
$jobs = [ordered]@{}
$inJobs = $false
$cur = $null
foreach ($line in $wfLines) {
  if ($line -match '^jobs:\s*$') { $inJobs = $true; continue }
  if (-not $inJobs) { continue }
  if ($line -match '^  ([A-Za-z0-9_-]+):\s*$') { $cur = $Matches[1]; $jobs[$cur] = @(); continue }
  if ($cur) { $jobs[$cur] += $line }
}
function Get-JobPermissions([string[]]$Lines) {
  $out = @(); $in = $false
  foreach ($l in $Lines) {
    if ($l -match '^    permissions:\s*$') { $in = $true; continue }
    if ($in) { if ($l -match '^      (\S.*)$') { $out += $Matches[1].Trim() } else { break } }
  }
  return $out
}
Check 'workflow-level permissions are {}' (($wfLines | Where-Object { $_ -match '^permissions:\s*\{\}\s*$' }).Count -eq 1)
Check 'jobs are start, build, publish, report' ((@($jobs.Keys) -join ',') -eq 'start,build,publish,report')
Check 'build permissions are exactly contents: read' (((Get-JobPermissions $jobs['build']) -join ';') -eq 'contents: read')
Check 'build runs on the self-hosted runner' ((($jobs['build'] | Where-Object { $_ -match '^    runs-on:' }) -join '') -match 'self-hosted')
Check 'build never references a token or secret' (-not (($jobs['build'] -join "`n") -match 'github\.token|GH_TOKEN|GITHUB_TOKEN|secrets\.'))
foreach ($j in 'start', 'publish', 'report') {
  Check "$j runs on ubuntu-latest" ((($jobs[$j] | Where-Object { $_ -match '^    runs-on:' }) -join '') -match 'runs-on:\s*ubuntu-latest\s*$')
}
Check 'start permissions' (((Get-JobPermissions $jobs['start']) -join ';') -eq 'contents: read;issues: write')
Check 'publish permissions' (((Get-JobPermissions $jobs['publish']) -join ';') -eq 'contents: write;pull-requests: write;issues: write')
Check 'report permissions' (((Get-JobPermissions $jobs['report']) -join ';') -eq 'contents: read;issues: write')
Check 'nothing reads needs.build.outputs' (-not (($wfLines -join "`n") -match 'needs\.build\.outputs'))
Check 'no secrets referenced' (-not (($wfLines -join "`n") -match 'secrets\.'))
Check 'publish needs build success' ((($jobs['publish'] | Where-Object { $_ -match '^    if:' }) -join '') -match "needs\.build\.result == 'success'")
Check 'publish runs no npm, npx, or node' (-not (($jobs['publish'] -join "`n") -match '\b(npm|npx|node)\b'))
Check 'every checkout drops credentials' ((($wfLines | Where-Object { $_ -match 'uses: actions/checkout@' }).Count) -eq (($wfLines | Where-Object { $_ -match 'persist-credentials: false' }).Count))
Check 'every action is pinned to a commit sha' (-not ($wfLines | Where-Object { $_ -match 'uses:\s*\S+@' -and $_ -notmatch 'uses:\s*\S+@[0-9a-f]{40}(\s|$)' }))

# Run the evaluate step as attempt 1 leaves it after a timeout: no diff, then with BLOCKED.md.
$shell = (Get-Process -Id $PID).Path
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lb-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
$savedEnv = @{ GITHUB_WORKSPACE = $env:GITHUB_WORKSPACE; RUNNER_TEMP = $env:RUNNER_TEMP; GITHUB_ENV = $env:GITHUB_ENV; LOCAL_BUILDER_BASE = $env:LOCAL_BUILDER_BASE }
try {
  $ws = Join-Path $tmp 'ws'
  $rt = Join-Path $tmp 'rt'
  New-Item -ItemType Directory $rt | Out-Null
  New-TestRepo $ws
  Push-Location $ws
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

# Publish git calls, lease-guarded push, PR reuse.
# Each attack is first shown to work without the fix, so the checks cannot pass vacuously.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lb-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
$savedEnv = @{}
foreach ($k in 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_GLOBAL') { $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }
try {
  $ws = Join-Path $tmp 'ws'
  $remote = (Join-Path $tmp 'remote.git') -replace '\\', '/'
  Invoke-TestGit init -q --bare $remote
  New-TestRepo $ws
  Push-Location $ws
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

  $leakDir = $tmp -replace '\\', '/'
  $hook = "#!/bin/sh`nenv > '$leakDir/leak-hook.txt'`n"
  foreach ($h in 'pre-commit', 'pre-push', 'post-commit', 'reference-transaction') { Set-Content (Join-Path $ws ".git/hooks/$h") $hook -NoNewline }
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
  if ((Get-Location).Path -like "$tmp*") { Pop-Location }
  foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], 'Process') }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# Open PR reuse on a relabel retry (Invoke-GitHub is replaced with a recorder)
$realInvokeGitHub = ${function:Invoke-GitHub}
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

# Failure labels: the trigger label comes off too, so a retry is just re-adding it (dry run A, issue #24).
$script:ghCalls = @()
Set-FailureLabels -Repo 'o/r' -Issue '24'
Check 'labels: adds local-builder-failed' (@($script:ghCalls | Where-Object { $_.Method -eq 'POST' -and $_.Uri -like '*/issues/24/labels' -and $_.Body -match 'local-builder-failed' }).Count -eq 1)
Check 'labels: removes local-builder-running' (@($script:ghCalls | Where-Object { $_.Method -eq 'DELETE' -and $_.Uri -like '*/issues/24/labels/local-builder-running' }).Count -eq 1)
Check 'labels: removes the local-builder trigger' (@($script:ghCalls | Where-Object { $_.Method -eq 'DELETE' -and $_.Uri -like '*/issues/24/labels/local-builder' }).Count -eq 1)
function Invoke-GitHub { param([string]$Method, [string]$Uri, [string]$Body) throw '404 label not on issue' }
$threw = $false
try { Set-FailureLabels -Repo 'o/r' -Issue '24' 6>$null | Out-Null } catch { $threw = $true }
Check 'labels: missing labels do not fail the report' (-not $threw)
${function:Invoke-GitHub} = $realInvokeGitHub

# Result artifact: build packages it, publish validates it as untrusted input, then applies it.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lb-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  $origin = Join-Path $tmp 'origin'
  New-TestRepo $origin
  Push-Location $origin
  New-Item -ItemType Directory src | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $origin 'src/a.ts'), "export const a = 1;`n")
  [System.IO.File]::WriteAllText((Join-Path $origin 'src/old.ts'), "export const old = 1;`n")
  Invoke-TestGit add -A
  Invoke-TestGit commit -q -m base
  $baseSha = (git rev-parse HEAD).Trim()
  Pop-Location

  # Build side: a Windows-style checkout (CRLF in the working tree) with the agent's changes.
  $bws = Join-Path $tmp 'build'
  Invoke-TestGit -c core.autocrlf=true clone -q $origin $bws
  Push-Location $bws
  Invoke-TestGit config core.autocrlf true
  Pop-Location
  [System.IO.File]::WriteAllText((Join-Path $bws 'src/a.ts'), "export const a = 2;`r`n")
  [System.IO.File]::WriteAllText((Join-Path $bws 'src/new.ts'), "export const n = 1;`r`n")
  Remove-Item (Join-Path $bws 'src/old.ts')
  $env:GITHUB_WORKSPACE = $bws
  $env:LOCAL_BUILDER_BASE = $baseSha
  $changed = @(Get-ChangedFiles)
  Check 'package: changed files found' ((($changed | Sort-Object) -join ',') -eq 'src/a.ts,src/new.ts,src/old.ts')
  $art = Join-Path $tmp 'art'
  $m = New-ResultArtifact -Workspace $bws -BaseSha $baseSha -ChangeId 'demo-change' -Changed $changed -Stats @{ attempts = 1; tests_first_try = 'yes'; edit_format = 'whole' } -OutDir $art
  Remove-Item Env:LOCAL_BUILDER_BASE
  Check 'package: manifest written' (Test-Path (Join-Path $art 'manifest.json'))
  Check 'package: delete recorded' (@($m.files | Where-Object { $_.op -eq 'delete' -and $_.path -eq 'src/old.ts' }).Count -eq 1)
  $aEntry = @($m.files | Where-Object { $_.path -eq 'src/a.ts' })[0]
  $aBytes = [System.IO.File]::ReadAllBytes((Join-Path $art $aEntry.blob))
  Check 'package: blob is the normalized (LF) content' (-not ($aBytes -contains 13) -and [System.Text.Encoding]::UTF8.GetString($aBytes) -eq "export const a = 2;`n")

  # Publish side: fresh checkout of the base.
  $allowed = @('src/a.ts', 'src/new.ts', 'src/old.ts')
  function New-PublishWorkspace([string]$Name) {
    $p = Join-Path $tmp $Name
    Invoke-TestGit -c core.autocrlf=false clone -q $origin $p
    return $p
  }
  $pws = New-PublishWorkspace 'pub'
  $valid = $null
  try { $valid = Test-ResultArtifact -Dir $art -BaseSha $baseSha -ChangeId 'demo-change' -Allowed $allowed -Workspace $pws } catch { Write-Host $_.Exception.Message }
  Check 'publish: a good artifact is accepted' ($null -ne $valid)
  if ($valid) {
    $paths = @(Install-ResultArtifact -Manifest $valid -Dir $art -Workspace $pws)
    Check 'publish: applied paths match the manifest' ((($paths | Sort-Object) -join ',') -eq 'src/a.ts,src/new.ts,src/old.ts')
    Check 'publish: file written byte-for-byte' ([System.IO.File]::ReadAllText((Join-Path $pws 'src/a.ts')) -eq "export const a = 2;`n")
    Check 'publish: deleted file removed' (-not (Test-Path (Join-Path $pws 'src/old.ts')))
  }

  function Edit-Manifest([string]$Dir, [scriptblock]$Change) {
    $mp = Join-Path $Dir 'manifest.json'
    $j = Get-Content -LiteralPath $mp -Raw | ConvertFrom-Json
    & $Change $j
    [System.IO.File]::WriteAllText($mp, (ConvertTo-Json -InputObject $j -Depth 6))
  }
  # Tamper cases use an untouched checkout ($pws already has the good artifact applied).
  $pws2 = New-PublishWorkspace 'pub2'
  function Test-Tampered([string]$Name, [scriptblock]$Mutate, [string]$Workspace = $pws2) {
    $d = Join-Path $tmp ('t-' + [guid]::NewGuid())
    Copy-Item -LiteralPath $art -Destination $d -Recurse
    & $Mutate $d
    $msg = ''
    try {
      Test-ResultArtifact -Dir $d -BaseSha $baseSha -ChangeId 'demo-change' -Allowed $allowed -Workspace $Workspace | Out-Null
    } catch { $msg = $_.Exception.Message }
    Check "tamper rejected: $Name ($msg)" ($msg -like 'artifact rejected:*')
  }
  Check 'tamper baseline: untouched artifact passes on the tamper checkout' ($null -ne (Test-ResultArtifact -Dir $art -BaseSha $baseSha -ChangeId 'demo-change' -Allowed $allowed -Workspace $pws2))
  Test-Tampered 'path not in tasks.md Files' { param($d) Edit-Manifest $d { param($j) $j.files[0].path = 'src/other.ts' } }
  Test-Tampered 'forbidden .github path' { param($d) Edit-Manifest $d { param($j) $j.files[0].path = '.github/workflows/x.yml' } }
  Test-Tampered 'parent escape' { param($d) Edit-Manifest $d { param($j) $j.files[0].path = '../x.ts' } }
  Test-Tampered 'absolute path' { param($d) Edit-Manifest $d { param($j) $j.files[0].path = '/etc/x.ts' } }
  Test-Tampered 'not normalized' { param($d) Edit-Manifest $d { param($j) $j.files[0].path = './src/a.ts' } }
  Test-Tampered 'duplicate path' { param($d) Edit-Manifest $d { param($j) $j.files = @($j.files) + @($j.files | Where-Object { $_.op -eq 'delete' }) } }
  Test-Tampered 'wrong base sha' { param($d) Edit-Manifest $d { param($j) $j.base_sha = ('0' * 40) } }
  Test-Tampered 'wrong change id' { param($d) Edit-Manifest $d { param($j) $j.change_id = 'other-change' } }
  Test-Tampered 'sha256 mismatch (same size)' { param($d) $bp = Join-Path $d 'files/0'; $bb = [System.IO.File]::ReadAllBytes($bp); $bb[0] = $bb[0] -bxor 1; [System.IO.File]::WriteAllBytes($bp, $bb) }
  Test-Tampered 'extra unlisted file' { param($d) [System.IO.File]::WriteAllText((Join-Path $d 'files/9'), 'x') }
  Test-Tampered 'extra file outside files/' { param($d) [System.IO.File]::WriteAllText((Join-Path $d 'run.ps1'), 'x') }
  Test-Tampered '11 files' { param($d) Edit-Manifest $d { param($j) $del = @($j.files | Where-Object { $_.op -eq 'delete' })[0]; $j.files = @(1..11 | ForEach-Object { $del }) } }
  Test-Tampered 'blob over 512 KB' { param($d)
    $big = Join-Path $d 'files/0'; [System.IO.File]::WriteAllBytes($big, (New-Object byte[] (600KB)))
    $h = (Get-FileHash -LiteralPath $big -Algorithm SHA256).Hash.ToLowerInvariant()
    Edit-Manifest $d { param($j) $e = @($j.files | Where-Object { $_.blob -eq 'files/0' })[0]; $e.sha256 = $h; $e.bytes = 600KB }.GetNewClosure() }
  Test-Tampered 'over 1 MB in total' { param($d) [System.IO.File]::WriteAllBytes((Join-Path $d 'files/0'), (New-Object byte[] (1100KB))) }
  Test-Tampered 'manifest over 16 KB' { param($d) $mp = Join-Path $d 'manifest.json'; [System.IO.File]::WriteAllText($mp, ([System.IO.File]::ReadAllText($mp) + (' ' * 17KB))) }
  Test-Tampered 'invalid JSON' { param($d) [System.IO.File]::WriteAllText((Join-Path $d 'manifest.json'), '{ not json') }
  Test-Tampered 'attempts: 3' { param($d) Edit-Manifest $d { param($j) $j.stats.attempts = 3 } }
  Test-Tampered 'free text in stats' { param($d) Edit-Manifest $d { param($j) $j.stats.tests_first_try = 'yes <img src=x>' } }
  Test-Tampered 'unknown top-level key' { param($d) Edit-Manifest $d { param($j) $j | Add-Member -NotePropertyName extra -NotePropertyValue 1 } }
  Test-Tampered 'unknown file-entry key' { param($d) Edit-Manifest $d { param($j) $j.files[0] | Add-Member -NotePropertyName mode -NotePropertyValue '100755' } }
  Test-Tampered 'bad op' { param($d) Edit-Manifest $d { param($j) $j.files[0].op = 'chmod' } }
  Test-Tampered 'blob path traversal' { param($d) Edit-Manifest $d { param($j) @($j.files | Where-Object { $_.blob })[0].blob = '../manifest.json' } }
  # A junction (no admin needed) standing in for a symlinked parent directory at the target.
  $pws3 = New-PublishWorkspace 'pub3'
  Remove-Item -Recurse -Force (Join-Path $pws3 'src')
  New-Item -ItemType Directory (Join-Path $tmp 'elsewhere') | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $pws3 'src') -Target (Join-Path $tmp 'elsewhere') | Out-Null
  Test-Tampered 'link at target path' { param($d) } $pws3
  (Get-Item (Join-Path $pws3 'src')).Delete()
} finally {
  Remove-Item Env:GITHUB_WORKSPACE -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# Failure comment from untrusted report text
$c = Format-FailureComment -Reason '@duane please look' -Blocked '' -Excerpt "line`n``````n::set-env name=X::y`nghp_abcdef123456" -RunUrl 'https://example/run'
Check 'comment: @mention neutralized' ($c -notmatch '@duane' -and $c -match ('@' + [char]0x200B + 'duane'))
Check 'comment: fence longer than any backtick run' ($c -match '(?m)^````$')
Check 'comment: workflow command neutralized' ($c -notmatch '(?m)^::')
Check 'comment: token redacted' ($c -notmatch 'ghp_abcdef')
$long = Format-FailureComment -Reason ('x' * 5000) -Blocked '' -Excerpt (((1..100) | ForEach-Object { "l$_" }) -join "`n") -RunUrl ''
Check 'comment: reason capped' ($long.Length -lt 3000)
Check 'comment: excerpt capped to 40 lines' ($long -notmatch '(?m)^l60$' -and $long -match '(?m)^l100$')
Check 'comment: fallback when no reason' ((Format-FailureComment -Reason '' -Blocked '' -Excerpt '' -RunUrl '') -match 'before it could report a reason')
$b = Format-FailureComment -Reason 'r' -Blocked 'need help' -Excerpt '' -RunUrl ''
Check 'comment: BLOCKED.md shown' ($b -match 'BLOCKED.md' -and $b -match 'need help')

if ($fails -gt 0) { Write-Host "$fails check(s) failed"; exit 1 }
Write-Host 'all checks passed'
