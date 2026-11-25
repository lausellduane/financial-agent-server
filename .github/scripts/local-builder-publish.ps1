# Local builder script for the GitHub-hosted jobs (start, publish, report) in
# .github/workflows/local-builder.yml. Runs under pwsh on ubuntu-latest. These jobs hold the
# write-scoped token and never run model-written code. The build job's artifacts are untrusted
# data: publish re-derives everything it can and validates the rest (see Test-ResultArtifact).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('start', 'publish', 'report')]
  [string]$Step
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-builder-common.ps1')

function Set-StepOutput {
  param([string]$Name, [string]$Value)
  $Value = ([string]$Value) -replace '[\r\n]', ' '
  if ($env:GITHUB_OUTPUT) {
    [System.IO.File]::AppendAllText($env:GITHUB_OUTPUT, ('{0}={1}{2}' -f $Name, $Value, "`n"), (New-Object System.Text.UTF8Encoding $false))
  }
}

function Get-NullDevice {
  if ($env:OS -eq 'Windows_NT') { return 'NUL' }
  return '/dev/null'
}

function Invoke-GitHub {
  param([string]$Method, [string]$Uri, [string]$Body)
  $headers = @{
    Authorization          = "Bearer $($env:GH_TOKEN)"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'local-builder-workflow'
  }
  $params = @{ Method = $Method; Uri = $Uri; Headers = $headers; TimeoutSec = 60 }
  if ($Body) {
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = [System.Text.Encoding]::UTF8.GetBytes($Body)
  }
  return Invoke-RestMethod @params
}

function Invoke-PublishGit {
  # Runs git with no hooks, no fsmonitor, no global config, and no token in the environment.
  # The auth header (if any) reaches only this git process, through GIT_CONFIG_* variables,
  # and is never written to .git/config.
  param([string[]]$GitArgs, [string]$AuthHeader)
  # git writes progress to stderr; under Stop, PowerShell 5.1 would turn that into an error.
  $ErrorActionPreference = 'Continue'
  $nul = Get-NullDevice
  $names = 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }
  try {
    foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $null, 'Process') }
    $env:GIT_CONFIG_GLOBAL = $nul
    if ($AuthHeader) {
      $env:GIT_CONFIG_COUNT = '1'
      $env:GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
      $env:GIT_CONFIG_VALUE_0 = $AuthHeader
    }
    $out = & git -c "core.hooksPath=$nul" -c core.fsmonitor=false -c credential.helper= @GitArgs 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = (($out | ForEach-Object { "$_" }) -join "`n") }
  } finally {
    foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n], 'Process') }
  }
}

function Get-PublishPushArgs {
  # Lease-guarded force push of the issue branch only. An empty ExpectedSha means the
  # branch must not exist yet. Anything but local-builder/issue-N (master included) is refused.
  param([string]$RemoteUrl, [string]$Branch, [string]$ExpectedSha)
  if ($Branch -notmatch '^local-builder/issue-[0-9]+$') { throw "Refusing to push branch '$Branch'." }
  if ($ExpectedSha -and $ExpectedSha -notmatch '^[0-9a-f]{40}$') { throw "Invalid expected sha '$ExpectedSha'." }
  return @('push', "--force-with-lease=refs/heads/${Branch}:$ExpectedSha", $RemoteUrl, "HEAD:refs/heads/$Branch")
}

function Get-RemoteBranchSha {
  param([string]$RemoteUrl, [string]$Branch, [string]$AuthHeader)
  $r = Invoke-PublishGit -GitArgs @('ls-remote', '--heads', $RemoteUrl, "refs/heads/$Branch") -AuthHeader $AuthHeader
  if ($r.ExitCode -ne 0) { throw "git ls-remote failed: $($r.Output)" }
  foreach ($line in ($r.Output -split "`n")) {
    if ($line -match "^([0-9a-f]{40})\s+refs/heads/$([regex]::Escape($Branch))$") { return $Matches[1] }
  }
  return ''
}

function Publish-PullRequest {
  # Reuses an open PR for the branch (a relabel retry after a previous run opened one);
  # otherwise opens a new one. Returns the PR object.
  param([string]$Repo, [string]$Branch, [string]$Title, [string]$Body)
  $owner = ($Repo -split '/')[0]
  $open = @(Invoke-GitHub -Method GET -Uri "https://api.github.com/repos/$Repo/pulls?state=open&head=$($owner):$Branch")
  $payload = @{ title = $Title; body = $Body }
  if ($open.Count -gt 0 -and $open[0].number) {
    return Invoke-GitHub -Method PATCH -Uri "https://api.github.com/repos/$Repo/pulls/$($open[0].number)" -Body ($payload | ConvertTo-Json -Depth 5)
  }
  $payload.head = $Branch
  $payload.base = 'master'
  return Invoke-GitHub -Method POST -Uri "https://api.github.com/repos/$Repo/pulls" -Body ($payload | ConvertTo-Json -Depth 5)
}

function Test-IsLink {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function Test-PathHasLink {
  # True if $Rel (relative to $Root) or any existing parent directory is a symlink/junction.
  param([string]$Root, [string]$Rel)
  $cur = $Root
  foreach ($part in ($Rel -split '/')) {
    $cur = Join-Path $cur $part
    if (Test-IsLink $cur) { return $true }
    if (-not (Test-Path -LiteralPath $cur)) { return $false }
  }
  return $false
}

function Reject-Artifact {
  # Fixed reason only; the artifact's own text is never echoed.
  param([string]$Check)
  throw "artifact rejected: $Check"
}

function Test-ResultArtifact {
  # Validates the build job's result artifact against values publish derived itself.
  # Returns the manifest on success; throws "artifact rejected: <check>" otherwise.
  param([string]$Dir, [string]$BaseSha, [string]$ChangeId, [string[]]$Allowed, [string]$Workspace)

  if (-not $Dir -or -not (Test-Path -LiteralPath $Dir -PathType Container)) { Reject-Artifact 'missing artifact' }
  if (Test-IsLink $Dir) { Reject-Artifact 'link in artifact' }
  $root = (Get-Item -LiteralPath $Dir -Force).FullName.TrimEnd('\', '/')

  # 1. Layout and size before parsing anything.
  $all = @(Get-ChildItem -LiteralPath $root -Recurse -Force)
  $present = @{}
  $total = 0
  foreach ($item in $all) {
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { Reject-Artifact 'link in artifact' }
    if ($item.PSIsContainer) { continue }
    $rel = $item.FullName.Substring($root.Length + 1) -replace '\\', '/'
    $present[$rel] = $item.Length
    $total += $item.Length
  }
  if (-not $present.ContainsKey('manifest.json')) { Reject-Artifact 'missing manifest' }
  if ($present['manifest.json'] -gt $MaxManifestBytes) { Reject-Artifact 'manifest too large' }
  if ($total -gt $MaxTotalBytes) { Reject-Artifact 'artifact too large' }

  # 2. Schema.
  try {
    $m = Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Reject-Artifact 'manifest is not valid JSON'
  }
  if ($null -eq $m -or $m -is [array]) { Reject-Artifact 'manifest shape' }
  $keys = @($m.PSObject.Properties.Name | Sort-Object)
  if (($keys -join ',') -ne 'base_sha,change_id,files,stats,version') { Reject-Artifact 'manifest keys' }
  if (-not ($m.version -is [int] -or $m.version -is [long]) -or $m.version -ne 1) { Reject-Artifact 'manifest version' }
  if (-not ($m.base_sha -is [string]) -or $m.base_sha -cnotmatch '^[0-9a-f]{40}$' -or $m.base_sha -cne $BaseSha) { Reject-Artifact 'base sha' }
  if (-not ($m.change_id -is [string]) -or $m.change_id -cne $ChangeId) { Reject-Artifact 'change id' }

  $s = $m.stats
  if ($null -eq $s -or $s -is [array] -or -not ($s -is [System.Management.Automation.PSCustomObject])) { Reject-Artifact 'stats shape' }
  if ((@($s.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'attempts,edit_format,tests_first_try') { Reject-Artifact 'stats keys' }
  if (-not ($s.attempts -is [int] -or $s.attempts -is [long]) -or @(1, 2) -notcontains $s.attempts) { Reject-Artifact 'stats attempts' }
  if (-not ($s.tests_first_try -is [string]) -or @('yes', 'no') -cnotcontains $s.tests_first_try) { Reject-Artifact 'stats tests_first_try' }
  if (-not ($s.edit_format -is [string]) -or @('whole', 'diff') -cnotcontains $s.edit_format) { Reject-Artifact 'stats edit_format' }

  $files = @($m.files)
  if ($null -eq $m.files -or $files.Count -eq 0) { Reject-Artifact 'no files' }
  if ($files.Count -gt $MaxFiles) { Reject-Artifact 'too many files' }

  # 3/4. Paths and content.
  $seenPaths = @{}
  $usedBlobs = @{ 'manifest.json' = $true }
  foreach ($f in $files) {
    if ($null -eq $f -or -not ($f -is [System.Management.Automation.PSCustomObject])) { Reject-Artifact 'file entry shape' }
    $fk = (@($f.PSObject.Properties.Name | Sort-Object) -join ',')
    if (-not ($f.path -is [string])) { Reject-Artifact 'file path' }
    $p = $f.path
    if ($p -cne (Get-NormalizedPath $p)) { Reject-Artifact 'path not normalized' }
    if (-not (Test-SafeRelPath $p)) { Reject-Artifact 'unsafe path' }
    if (Test-ForbiddenPath $p) { Reject-Artifact 'forbidden path' }
    if (Test-AiderArtifact $p) { Reject-Artifact 'aider file' }
    if ($Allowed -cnotcontains $p) { Reject-Artifact 'path not in tasks.md Files' }
    if ($seenPaths.ContainsKey($p.ToLowerInvariant())) { Reject-Artifact 'duplicate path' }
    $seenPaths[$p.ToLowerInvariant()] = $true
    if (Test-PathHasLink -Root $Workspace -Rel $p) { Reject-Artifact 'link at target path' }

    if ($f.op -ceq 'write') {
      if ($fk -ne 'blob,bytes,op,path,sha256') { Reject-Artifact 'file entry keys' }
      if (-not ($f.blob -is [string]) -or $f.blob -cnotmatch '^files/[0-9]{1,3}$') { Reject-Artifact 'blob name' }
      if ($usedBlobs.ContainsKey($f.blob)) { Reject-Artifact 'blob reused' }
      if (-not $present.ContainsKey($f.blob)) { Reject-Artifact 'blob missing' }
      $usedBlobs[$f.blob] = $true
      if (-not ($f.bytes -is [int] -or $f.bytes -is [long]) -or $f.bytes -lt 0 -or $f.bytes -ne $present[$f.blob]) { Reject-Artifact 'blob size' }
      if ($present[$f.blob] -gt $MaxBlobBytes) { Reject-Artifact 'blob too large' }
      if (-not ($f.sha256 -is [string]) -or $f.sha256 -cnotmatch '^[0-9a-f]{64}$') { Reject-Artifact 'blob hash format' }
      $actual = (Get-FileHash -LiteralPath (Join-Path $root $f.blob) -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -cne $f.sha256) { Reject-Artifact 'blob hash' }
    } elseif ($f.op -ceq 'delete') {
      if ($fk -ne 'op,path') { Reject-Artifact 'file entry keys' }
      if (-not (Test-Path -LiteralPath (Join-Path $Workspace $p) -PathType Leaf)) { Reject-Artifact 'delete of missing file' }
    } else {
      Reject-Artifact 'file op'
    }
  }
  foreach ($k in $present.Keys) {
    if (-not $usedBlobs.ContainsKey($k)) { Reject-Artifact 'unlisted file in artifact' }
  }
  return $m
}

function Install-ResultArtifact {
  # Writes the validated manifest's files into the checkout, then checks git sees exactly
  # those paths changed and nothing else. Call only after Test-ResultArtifact.
  param($Manifest, [string]$Dir, [string]$Workspace)
  $root = (Get-Item -LiteralPath $Dir -Force).FullName
  $expected = @()
  foreach ($f in @($Manifest.files)) {
    $target = Join-Path $Workspace $f.path
    if ($f.op -ceq 'write') {
      $parent = Split-Path $target -Parent
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      if (Test-PathHasLink -Root $Workspace -Rel $f.path) { Reject-Artifact 'link at target path' }
      [System.IO.File]::WriteAllBytes($target, [System.IO.File]::ReadAllBytes((Join-Path $root $f.blob)))
    } else {
      Remove-Item -LiteralPath $target -Force
    }
    $expected += $f.path
  }
  Push-Location $Workspace
  try {
    $r = Invoke-PublishGit -GitArgs (@('add', '-A', '--') + $expected)
    if ($r.ExitCode -ne 0) { throw "git add failed. $($r.Output)" }
    $status = Invoke-PublishGit -GitArgs @('status', '--porcelain', '--untracked-files=all', '--no-renames')
    if ($status.ExitCode -ne 0) { throw "git status failed. $($status.Output)" }
    $changed = @($status.Output -split "`n" | Where-Object { $_ } | ForEach-Object { $_.Substring(3).Trim('"') } | Sort-Object -Unique)
    $want = @($expected | Sort-Object -Unique)
    if (($changed -join "`n") -cne ($want -join "`n")) { Reject-Artifact 'resulting diff does not match manifest' }
    $summary = Invoke-PublishGit -GitArgs @('diff', '--cached', '--summary', '--no-renames')
    if ($summary.Output -match 'mode change|symlink|120000') { Reject-Artifact 'mode change' }
    if ((Invoke-PublishGit -GitArgs @('diff', '--cached', '--quiet')).ExitCode -eq 0) { Reject-Artifact 'no changes' }
  } finally {
    Pop-Location
  }
  return $want
}

function Get-ElapsedText {
  param([string]$Start)
  if (-not $Start) { return 'unknown' }
  try {
    $s = [DateTime]::Parse($Start, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
    $elapsed = [DateTime]::UtcNow - $s.ToUniversalTime()
    return ('{0}m {1}s (job start -> PR opened)' -f [int][Math]::Floor($elapsed.TotalMinutes), $elapsed.Seconds)
  } catch {
    return 'unknown'
  }
}

function Limit-Text {
  param([string]$Text, [int]$MaxChars, [int]$MaxLines = 0)
  if (-not $Text) { return '' }
  $t = $Text.Trim()
  if ($MaxLines -gt 0) {
    $lines = @($t -split '\r?\n')
    if ($lines.Count -gt $MaxLines) { $t = ($lines | Select-Object -Last $MaxLines) -join "`n" }
  }
  if ($t.Length -gt $MaxChars) { $t = $t.Substring($t.Length - $MaxChars) }
  return $t
}

function Protect-CommentText {
  # Untrusted text from the build job: redact tokens, neutralize workflow commands and @mentions.
  param([string]$Text)
  $t = Sanitize-LogText $Text
  return ($t -replace '@', ('@' + [char]0x200B))
}

function Get-CodeFence {
  param([string]$Text)
  $longest = 0
  foreach ($m in [regex]::Matches([string]$Text, '`+')) { if ($m.Length -gt $longest) { $longest = $m.Length } }
  return ([string][char]96) * ([Math]::Max(3, $longest + 1))
}

function Format-FailureComment {
  param([string]$Reason, [string]$Blocked, [string]$Excerpt, [string]$RunUrl)
  $reasonText = Protect-CommentText (Limit-Text $Reason 2000)
  $blockedText = Protect-CommentText (Limit-Text $Blocked 2000)
  $excerptText = Protect-CommentText (Limit-Text $Excerpt 6000 40)
  if (-not $reasonText -and -not $blockedText) { $reasonText = 'The local-builder job failed or was cancelled before it could report a reason.' }
  $nl = "`n"
  $c = 'Local builder failed for this issue.' + $nl + $nl
  if ($blockedText) {
    $fence = Get-CodeFence $blockedText
    $c += 'The agent wrote BLOCKED.md:' + $nl + $nl + $fence + $nl + $blockedText + $nl + $fence
  } else {
    $c += $reasonText
  }
  if ($excerptText) {
    $fence = Get-CodeFence $excerptText
    $c += $nl + $nl + $fence + $nl + $excerptText + $nl + $fence
  }
  if ($RunUrl) { $c += $nl + $nl + "Run: $RunUrl" }
  return $c
}

function Set-FailureLabels {
  # Adds local-builder-failed and removes both local-builder-running and the local-builder
  # trigger label. start removes the trigger only after the issue parses, so an early
  # failure would otherwise leave it on and a retry would need a remove and re-add.
  param([string]$Repo, [string]$Issue)
  try {
    Invoke-GitHub -Method POST -Uri "https://api.github.com/repos/$Repo/issues/$Issue/labels" -Body '{"labels":["local-builder-failed"]}' | Out-Null
  } catch {
    Write-Host "Failed to add local-builder-failed. $($_.Exception.Message)"
  }
  foreach ($label in 'local-builder-running', 'local-builder') {
    try {
      Invoke-GitHub -Method DELETE -Uri "https://api.github.com/repos/$Repo/issues/$Issue/labels/$label" | Out-Null
    } catch {
      Write-Host "$label was already absent."
    }
  }
}

function Read-OptionalText {
  param([string]$Dir, [string]$Name)
  if (-not $Dir) { return '' }
  $p = Join-Path $Dir $Name
  if (-not (Test-Path -LiteralPath $p -PathType Leaf) -or (Test-IsLink $p)) { return '' }
  if ((Get-Item -LiteralPath $p -Force).Length -gt 256KB) { return '[report file too large]' }
  return [string](Get-Content -LiteralPath $p -Raw -Encoding UTF8)
}

$repo = $env:GITHUB_REPOSITORY
$issue = $env:ISSUE_NUMBER
if ($issue -notmatch '^[0-9]+$') { throw 'ISSUE_NUMBER is missing or invalid.' }

switch ($Step) {

  'start' {
    # Runs before any model-written code, on a fresh GitHub-hosted VM.
    try {
      Set-StepOutput 'job_start' ([DateTime]::UtcNow.ToString('o'))
      $event = Get-Content -LiteralPath $env:GITHUB_EVENT_PATH -Raw -Encoding UTF8 | ConvertFrom-Json
      $body = [string]$event.issue.body
      if ([string]::IsNullOrWhiteSpace($body)) { throw 'Issue body is empty. Add a line: openspec-change: <id>' }
      $changeId = $null
      $taskSpec = ''
      foreach ($line in ($body -split '\r?\n')) {
        if ($line -match '^openspec-change:\s*([a-z0-9-]+)\s*$') { $changeId = $Matches[1] }
        elseif ($line -match '^tasks:\s*([0-9.,]+)\s*$') { $taskSpec = $Matches[1] }
      }
      if (-not $changeId) {
        throw 'Missing or malformed change ID. The issue body must contain a line matching openspec-change: <id> with id ^[a-z0-9-]+$.'
      }
      $tasksPath = Join-Path $env:GITHUB_WORKSPACE "openspec/changes/$changeId/tasks.md"
      if (-not (Test-Path -LiteralPath $tasksPath -PathType Leaf)) { throw "openspec/changes/$changeId/tasks.md was not found on master." }
      # Fail early on a bad tasks: line or Files: list, before the PC is used.
      $null = Resolve-ChangeSelection -TasksText (Get-Content -LiteralPath $tasksPath -Raw -Encoding UTF8) -TaskSpec $taskSpec -ChangeId $changeId
      Set-StepOutput 'change_id' $changeId
      Set-StepOutput 'task_spec' $taskSpec

      try {
        Invoke-GitHub -Method POST -Uri "https://api.github.com/repos/$repo/issues/$issue/labels" -Body '{"labels":["local-builder-running"]}' | Out-Null
      } catch {
        throw "Failed to add local-builder-running to issue #$issue. $($_.Exception.Message)"
      }
      try {
        Invoke-GitHub -Method DELETE -Uri "https://api.github.com/repos/$repo/issues/$issue/labels/local-builder" | Out-Null
      } catch {
        Write-Host "Could not remove local-builder from issue #$issue (it may already be gone)."
      }
      Write-Host "Start ok: change $changeId, tasks '$taskSpec'."
    } catch {
      Set-StepOutput 'reason' $_.Exception.Message
      Write-Host $_.Exception.Message
      exit 1
    }
  }

  'publish' {
    try {
      if (-not $env:GH_TOKEN) { throw 'GH_TOKEN is missing in the publish job.' }
      $changeId = $env:CHANGE_ID
      if ($changeId -cnotmatch '^[a-z0-9-]+$') { throw 'CHANGE_ID from the start job is missing or invalid.' }
      $baseSha = $env:GITHUB_SHA
      $ws = $env:GITHUB_WORKSPACE
      Push-Location $ws
      try {
        $head = (Invoke-PublishGit -GitArgs @('rev-parse', 'HEAD')).Output.Trim()
      } finally { Pop-Location }
      if ($head -cne $baseSha) { throw 'The publish checkout is not at github.sha.' }

      # Re-derive the allowed files and task numbers from tasks.md at github.sha.
      $tasksPath = Join-Path $ws "openspec/changes/$changeId/tasks.md"
      if (-not (Test-Path -LiteralPath $tasksPath -PathType Leaf)) { throw "openspec/changes/$changeId/tasks.md was not found at $baseSha." }
      $sel = Resolve-ChangeSelection -TasksText (Get-Content -LiteralPath $tasksPath -Raw -Encoding UTF8) -TaskSpec $env:TASK_SPEC -ChangeId $changeId

      $m = Test-ResultArtifact -Dir $env:ARTIFACT_DIR -BaseSha $baseSha -ChangeId $changeId -Allowed $sel.Allowed -Workspace $ws
      $branch = "local-builder/issue-$issue"
      Push-Location $ws
      try {
        $r = Invoke-PublishGit -GitArgs @('checkout', '-B', $branch, $baseSha)
        if ($r.ExitCode -ne 0) { throw "git checkout -B $branch failed." }
      } finally { Pop-Location }
      $paths = @(Install-ResultArtifact -Manifest $m -Dir $env:ARTIFACT_DIR -Workspace $ws)

      $taskNumbers = $sel.TaskNumbers
      $msg = "[local-builder] ${changeId}: tasks ${taskNumbers}"
      $remoteUrl = "https://github.com/$repo.git"
      $authHeader = "AUTHORIZATION: bearer $($env:GH_TOKEN)"
      Push-Location $ws
      try {
        $r = Invoke-PublishGit -GitArgs @('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '--no-verify', '-m', $msg)
        if ($r.ExitCode -ne 0) { throw "git commit failed. $($r.Output)" }
        # A relabel retry overwrites the old remote branch, but only if it is still where
        # ls-remote saw it (lease), and never master.
        $remoteSha = Get-RemoteBranchSha -RemoteUrl $remoteUrl -Branch $branch -AuthHeader $authHeader
        if ($remoteSha) { Write-Host "Replacing existing $branch at $remoteSha (lease-guarded)." }
        $r = Invoke-PublishGit -GitArgs (Get-PublishPushArgs -RemoteUrl $remoteUrl -Branch $branch -ExpectedSha $remoteSha) -AuthHeader $authHeader
        if ($r.ExitCode -ne 0) { throw "git push of $branch failed. $(Sanitize-LogText $r.Output)" }
      } finally { Pop-Location }

      $scenarios = @(Get-ScenarioHeadings -Root $ws -ChangeId $changeId -WantedNames $sel.WantedScenarios)
      $scenarioMd = if ($scenarios.Count -gt 0) { ($scenarios | ForEach-Object { "- $_" }) -join "`n" } else { '- (none found in the change specs)' }
      $runTime = Get-ElapsedText $env:JOB_START
      $prBody = @"
Opened by the local builder for issue #$issue (``openspec/changes/$changeId``), tasks $taskNumbers.

### Spec scenarios
$scenarioMd

<!-- local-builder-stats -->
### Local builder stats
| Field | Value |
|---|---|
| Model | qwen2.5-coder:7b (num_ctx 4096) |
| Attempts | $($m.stats.attempts) of 2 |
| Run time | $runTime |
| Tests passed on first try | $($m.stats.tests_first_try) |
| Edit format | $($m.stats.edit_format) |
| Files changed | $($paths.Count) |
| Issue / change | #$issue / openspec/changes/$changeId |
"@
      $pr = Publish-PullRequest -Repo $repo -Branch $branch -Title $msg -Body $prBody
      Write-Host "Opened or updated PR $($pr.html_url)"
      Invoke-GitHub -Method POST -Uri "https://api.github.com/repos/$repo/issues/$($pr.number)/labels" -Body '{"labels":["local-builder"]}' | Out-Null
      try {
        Invoke-GitHub -Method DELETE -Uri "https://api.github.com/repos/$repo/issues/$issue/labels/local-builder-running" | Out-Null
      } catch {
        Write-Host 'Could not remove local-builder-running from the issue (it may already be gone).'
      }
    } catch {
      $reason = $_.Exception.Message
      if ($reason -notmatch '^artifact rejected: ') { $reason = 'publish failed: ' + (Sanitize-LogText $reason) }
      Set-StepOutput 'reason' $reason
      Write-Host $reason
      exit 1
    }
  }

  'report' {
    # Reason precedence: start's (trusted), then publish's (trusted) when build succeeded,
    # then the build job's report artifact (untrusted), then a fixed fallback.
    $runUrl = "$($env:GITHUB_SERVER_URL)/$repo/actions/runs/$($env:GITHUB_RUN_ID)"
    $reason = ''
    $blocked = ''
    $excerpt = ''
    if ($env:START_RESULT -ne 'success') {
      $reason = $env:START_REASON
      if (-not $reason) { $reason = 'The local-builder start job failed or was cancelled.' }
    } elseif ($env:BUILD_RESULT -eq 'success' -and $env:PUBLISH_REASON) {
      $reason = $env:PUBLISH_REASON
    } else {
      $reason = Read-OptionalText $env:REPORT_DIR 'reason.txt'
      $blocked = Read-OptionalText $env:REPORT_DIR 'blocked.md'
      $excerpt = Read-OptionalText $env:REPORT_DIR 'log-excerpt.txt'
    }
    $comment = Format-FailureComment -Reason $reason -Blocked $blocked -Excerpt $excerpt -RunUrl $runUrl
    try {
      Invoke-GitHub -Method POST -Uri "https://api.github.com/repos/$repo/issues/$issue/comments" -Body (@{ body = $comment } | ConvertTo-Json -Depth 5) | Out-Null
      Write-Host "Posted failure comment on issue #$issue."
    } catch {
      Write-Host "Failed to comment on issue #$issue. $($_.Exception.Message)"
    }
    Set-FailureLabels -Repo $repo -Issue $issue
  }
}
