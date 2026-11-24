# Local builder step script for Windows PowerShell 5.1+ / pwsh.
# Invoked by .github/workflows/local-builder.yml with -Step <name>.
# Reads issue text only from $env:GITHUB_EVENT_PATH (never from workflow ${{ }} in run:).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('tools', 'parse-change', 'warmup', 'render', 'aider', 'evaluate', 'guard', 'publish')]
  [string]$Step
)

$ErrorActionPreference = 'Stop'

$ReasonPath = Join-Path $env:RUNNER_TEMP 'local-builder-reason.txt'
$LogPath = Join-Path $env:RUNNER_TEMP 'local-builder.log'
$AllowedPath = Join-Path $env:RUNNER_TEMP 'allowed-files.txt'
$ScenarioPath = Join-Path $env:RUNNER_TEMP 'scenarios.txt'
$ExcerptPath = Join-Path $env:RUNNER_TEMP 'test-failure-excerpt.txt'
$PromptPath = Join-Path $env:RUNNER_TEMP 'job-prompt.md'
$TaskNumsPath = Join-Path $env:RUNNER_TEMP 'task-numbers.txt'

function Write-JobLog {
  param([string]$Message)
  $line = '{0} {1}' -f (Get-Date -Format 'o'), $Message
  Add-Content -Path $LogPath -Value $line -Encoding UTF8
  Write-Host $Message
}

function Set-Reason {
  param([string]$Message)
  Set-Content -Path $ReasonPath -Value $Message -Encoding UTF8
  Write-JobLog $Message
}

function Fail-Job {
  param([string]$Message)
  Set-Reason $Message
  exit 1
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  $enc = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::AppendAllText($Path, $Text, $enc)
}

function Set-JobEnv {
  param([string]$Name, [string]$Value)
  if (-not $env:GITHUB_ENV) { return }
  $Name = $Name -replace '[\r\n]', ''
  $Value = ([string]$Value) -replace '[\r\n]', ' '
  Write-Utf8NoBom -Path $env:GITHUB_ENV -Text ('{0}={1}{2}' -f $Name, $Value, [Environment]::NewLine)
}

function Add-JobPath {
  param([string]$Directory)
  if (-not $env:GITHUB_PATH) { return }
  $Directory = ([string]$Directory) -replace '[\r\n]', ''
  Write-Utf8NoBom -Path $env:GITHUB_PATH -Text ($Directory + [Environment]::NewLine)
}

function Add-LocalBinToPath {
  $candidates = @(
    (Join-Path $env:USERPROFILE '.local\bin'),
    (Join-Path $env:USERPROFILE 'AppData\Local\uv\bin'),
    (Join-Path $env:LOCALAPPDATA 'uv\bin'),
    (Join-Path $env:USERPROFILE 'AppData\Roaming\Python\Scripts'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\Scripts')
  )
  $added = @()
  foreach ($dir in $candidates) {
    if ($dir -and (Test-Path -LiteralPath $dir)) {
      $env:Path = $dir + ';' + $env:Path
      $added += $dir
    }
  }
  if ($env:GITHUB_PATH) {
    foreach ($dir in $added) {
      Add-JobPath $dir
    }
  }
  return $added
}

function Get-NormalizedPath {
  param([string]$PathValue)
  # Strip only leading "./" (never every leading dot), so .github/x and .env keep their dot.
  return (($PathValue -replace '\\', '/').Trim() -replace '^(\./+)+', '')
}

function Test-SafeRelPath {
  param([string]$PathValue)
  $n = Get-NormalizedPath $PathValue
  if ([string]::IsNullOrWhiteSpace($n)) { return $false }
  if ($n -match '(^|/)\.\.(/|$)') { return $false }
  if ($n -match '^[a-zA-Z]:') { return $false }
  if ($n.StartsWith('/')) { return $false }
  if ($n -eq '.git' -or $n -match '(^|/)\.git(/|$)') { return $false }
  if ($n -notmatch '^[A-Za-z0-9_./-]+$') { return $false }
  return $true
}

function Test-AiderArtifact {
  param([string]$PathValue)
  $n = Get-NormalizedPath $PathValue
  $leaf = Split-Path $n -Leaf
  if ($leaf -like '.aider*') { return $true }
  if ($n -like '.aider*') { return $true }
  return $false
}

function Test-ForbiddenPath {
  param([string]$PathValue)
  $n = Get-NormalizedPath $PathValue
  if ($n -eq '.git' -or $n -match '(^|/)\.git(/|$)') { return $true }
  if ($n -match '(^|/)\.github(/|$)') { return $true }
  if ($n -match '(^|/)wrangler\.[^/]+$') { return $true }
  if ($n -match '(^|/)migrations(/|$)') { return $true }
  if ($n -match '(^|/)\.env') { return $true }
  if ($n -match '(^|/)\.dev\.vars') { return $true }
  if ($n -match '\.(pem|key)$') { return $true }
  return $false
}

function Get-BaseRef {
  # Same ref the branch was created from (set in parse-change); never local master.
  if ($env:LOCAL_BUILDER_BASE) { return $env:LOCAL_BUILDER_BASE }
  return 'origin/master'
}

function Get-ChangedFiles {
  param([string]$BaseRef = (Get-BaseRef))
  Push-Location $env:GITHUB_WORKSPACE
  try {
    $names = @()
    $names += @(git diff --name-only $BaseRef 2>$null)
    $names += @(git ls-files --others --exclude-standard 2>$null)
    $names = $names | Where-Object { $_ -and $_.Trim() } | ForEach-Object { Get-NormalizedPath $_ } | Sort-Object -Unique
    $names = @($names | Where-Object { -not (Test-AiderArtifact $_) })
    return $names
  } finally {
    Pop-Location
  }
}

function Get-TaskBlocks {
  param([string]$Text)
  $blocks = @()
  $rx = [regex]'(?m)^-\s+\[([ xX])\]\s+(\d+(?:\.\d+)*)\b.*$'
  $matches = $rx.Matches($Text)
  for ($i = 0; $i -lt $matches.Count; $i++) {
    $m = $matches[$i]
    $start = $m.Index
    $end = if ($i -lt $matches.Count - 1) { $matches[$i + 1].Index } else { $Text.Length }
    $blocks += [pscustomobject]@{
      Id      = $m.Groups[2].Value
      Checked = $m.Groups[1].Value -ne ' '
      Body    = $Text.Substring($start, $end - $start)
    }
  }
  return $blocks
}

function Get-FilesFromTaskBody {
  param([string]$Body)
  $files = @()
  $lines = $Body -split '\r?\n'
  $inFiles = $false
  foreach ($line in $lines) {
    if ($line -match '(?i)Files:\s*(.*)$') {
      $inFiles = $true
      $rest = $Matches[1].Trim()
      if ($rest) {
        $parts = $rest -split ',' | ForEach-Object { $_.Trim().Trim('`').Trim('"').Trim() } | Where-Object { $_ }
        foreach ($p in $parts) { if (Test-SafeRelPath $p) { $files += (Get-NormalizedPath $p) } }
      }
      continue
    }
    if ($inFiles) {
      if ($line -match '^\s*$') { $inFiles = $false; continue }
      if ($line -match '^\s*-\s+(.+)$') {
        $p = $Matches[1].Trim().Trim('`').Trim('"').Trim()
        if (Test-SafeRelPath $p) {
          $files += (Get-NormalizedPath $p)
          continue
        }
      }
      $inFiles = $false
    }
  }
  return $files
}

function Get-ScenarioNamesFromTaskBody {
  param([string]$Body)
  $names = @()
  $lines = $Body -split '\r?\n'
  $inScenarios = $false
  foreach ($line in $lines) {
    if ($line -match '(?i)Scenarios?:\s*(.*)$') {
      $inScenarios = $true
      $rest = $Matches[1].Trim()
      if ($rest) {
        $parts = $rest -split ',' | ForEach-Object { $_.Trim().Trim('`').Trim('"').Trim() } | Where-Object { $_ }
        foreach ($part in $parts) {
          $names += ($part -replace '^####\s+Scenario:\s*', '')
        }
      }
      continue
    }
    if ($inScenarios) {
      if ($line -match '^\s*$') { $inScenarios = $false; continue }
      if ($line -match '^\s*-\s+(.+)$') {
        $n = $Matches[1].Trim().Trim('`').Trim('"').Trim()
        $n = $n -replace '^(####\s+)?Scenario:\s*', ''
        if ($n) { $names += $n; continue }
      }
      $inScenarios = $false
    }
  }
  return $names
}

function Get-ScenarioHeadings {
  param([string]$ChangeId, [string[]]$WantedNames)
  $headings = @()
  $specsRoot = Join-Path $env:GITHUB_WORKSPACE "openspec/changes/$ChangeId/specs"
  if (-not (Test-Path -LiteralPath $specsRoot)) { return $headings }
  $files = Get-ChildItem -LiteralPath $specsRoot -Recurse -Filter '*.md' -File -ErrorAction SilentlyContinue
  foreach ($f in $files) {
    $text = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
    foreach ($m in [regex]::Matches($text, '(?m)^####\s+Scenario:\s*(.+?)\s*$')) {
      $headings += ('#### Scenario: ' + $m.Groups[1].Value.Trim())
    }
  }
  $wanted = @($WantedNames | Where-Object { $_ } | ForEach-Object { ($_ -replace '^####\s+Scenario:\s*', '').Trim() } | Sort-Object -Unique)
  if ($wanted.Count -eq 0) {
    Write-JobLog 'No Scenarios: list on the selected tasks; including all change-level scenario headings.'
    return $headings
  }
  $filtered = @()
  foreach ($h in $headings) {
    $title = ($h -replace '^####\s+Scenario:\s*', '').Trim()
    foreach ($w in $wanted) {
      if ([string]::Equals($title, $w, [System.StringComparison]::OrdinalIgnoreCase)) {
        $filtered += $h
        break
      }
    }
  }
  if ($filtered.Count -eq 0) {
    Write-JobLog 'Scenarios: names on the selected tasks did not match any heading; including all change-level scenario headings.'
    return $headings
  }
  Write-JobLog ('Filtered scenarios to selected tasks: ' + ($filtered -join '; '))
  return $filtered
}

function Get-EstTokens {
  param([string[]]$Paths, [string]$ExtraText)
  $chars = 0
  if ($ExtraText) { $chars += $ExtraText.Length }
  foreach ($p in $Paths) {
    $full = if ([System.IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $env:GITHUB_WORKSPACE $p }
    if (Test-Path -LiteralPath $full) {
      $chars += (Get-Content -LiteralPath $full -Raw -Encoding UTF8).Length
    }
  }
  return [int][Math]::Ceiling($chars / 4.0)
}

function Render-Prompt {
  param([string]$Attempt, [string]$Excerpt)
  $changeId = $env:CHANGE_ID
  $changePath = "openspec/changes/$changeId"
  $templatePath = Join-Path $env:GITHUB_WORKSPACE 'prompts/job-prompt.md'
  if (-not (Test-Path -LiteralPath $templatePath)) {
    Fail-Job "prompts/job-prompt.md is missing from the checkout."
  }
  $template = Get-Content -LiteralPath $templatePath -Raw -Encoding UTF8
  $template = [regex]::Replace($template, '(?s)<!--.*?-->', '').Trim()
  $files = @()
  if (Test-Path -LiteralPath $AllowedPath) {
    $files = @(Get-Content -LiteralPath $AllowedPath -Encoding UTF8 | Where-Object { $_ })
  }
  $scenarios = 'none'
  if (Test-Path -LiteralPath $ScenarioPath) {
    $sc = @(Get-Content -LiteralPath $ScenarioPath -Encoding UTF8 | Where-Object { $_ })
    if ($sc.Count -gt 0) { $scenarios = ($sc -join "`n") }
  }
  $taskNumbers = $env:TASK_NUMBERS
  if (Test-Path -LiteralPath $TaskNumsPath) {
    $taskNumbers = (Get-Content -LiteralPath $TaskNumsPath -Raw -Encoding UTF8).Trim()
  }
  if (-not $Excerpt) { $Excerpt = 'none' }
  $filesText = if ($files.Count -gt 0) { ($files | ForEach-Object { "- $_" }) -join "`n" } else { 'none' }
  $template = $template.Replace('{{CHANGE_PATH}}', $changePath)
  $template = $template.Replace('{{TASK_NUMBERS}}', $taskNumbers)
  $template = $template.Replace('{{FILES}}', $filesText)
  $template = $template.Replace('{{SCENARIOS}}', $scenarios)
  $template = $template.Replace('{{ATTEMPT}}', $Attempt)
  $template = $template.Replace('{{TEST_FAILURE_EXCERPT}}', $Excerpt)
  Set-Content -LiteralPath $PromptPath -Value $template -Encoding UTF8
  return $template
}

function Invoke-GitHub {
  param(
    [string]$Method,
    [string]$Uri,
    [string]$Body
  )
  $headers = @{
    Authorization             = "Bearer $($env:GH_TOKEN)"
    Accept                    = 'application/vnd.github+json'
    'X-GitHub-Api-Version'    = '2022-11-28'
    'User-Agent'              = 'local-builder-workflow'
  }
  $params = @{
    Method      = $Method
    Uri         = $Uri
    Headers     = $headers
    TimeoutSec  = 60
  }
  if ($Body) {
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = [System.Text.Encoding]::UTF8.GetBytes($Body)
  }
  return Invoke-RestMethod @params
}

function Sanitize-LogText {
  param([string]$Text)
  if (-not $Text) { return '' }
  $t = $Text
  $t = [regex]::Replace($t, '(?i)(Bearer\s+)[^\s]+', '$1[redacted]')
  $t = [regex]::Replace($t, '(?i)(gh[pousr]_[A-Za-z0-9]+)', '[redacted]')
  $lines = $t -split '\r?\n' | ForEach-Object { $_ -replace '^::', ' :' }
  return ($lines -join "`n")
}

function Get-TailText {
  param([string]$Path, [int]$Lines = 40)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $content = Get-Content -LiteralPath $Path -Encoding UTF8
  $tail = $content | Select-Object -Last $Lines
  return (Sanitize-LogText ($tail -join "`n"))
}

function Get-ElapsedText {
  if (-not $env:JOB_START) { return 'unknown' }
  try {
    $start = [DateTime]::Parse($env:JOB_START, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
    $elapsed = [DateTime]::UtcNow - $start.ToUniversalTime()
    $mins = [int][Math]::Floor($elapsed.TotalMinutes)
    $secs = $elapsed.Seconds
    return ('{0}m {1}s (job start -> PR opened)' -f $mins, $secs)
  } catch {
    return 'unknown'
  }
}

switch ($Step) {

  'tools' {
    $added = Add-LocalBinToPath
    if ($added.Count -gt 0) { Write-JobLog ('Added to PATH: ' + ($added -join '; ')) }

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { Fail-Job 'git was not found on PATH. Install Git for Windows and restart the runner.' }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Fail-Job 'node was not found on PATH. Install Node.js 22 LTS (the version CI uses) for the same Windows account that runs the runner, then restart the runner.' }
    $nodeVer = (& node -v 2>&1 | Out-String).Trim()
    Write-JobLog "node $nodeVer"
    if ($nodeVer -notmatch '^v22\.') {
      Write-JobLog "Warning: CI uses Node 22; this machine has $nodeVer. Jobs may still run, but install Node 22 LTS if tests fail."
    }

    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) { Fail-Job 'npm was not found on PATH. Install Node.js 22 LTS for the runner account and restart the runner.' }

    $aider = Get-Command aider -ErrorAction SilentlyContinue
    if (-not $aider) {
      Fail-Job ("aider was not found on PATH for Windows user '{0}'. Install Aider for the same account that runs the runner (if the runner is a service, that may be ghrunner, not your login). Then restart the runner. PATH={1}" -f $env:USERNAME, $env:Path)
    }
    $aiderVer = (& aider --version 2>&1 | Out-String).Trim()
    Write-JobLog "aider $aiderVer"
    Set-JobEnv 'AIDER_VERSION' $aiderVer
  }

  'parse-change' {
    $changeId = $env:CHANGE_ID
    if ($changeId -notmatch '^[a-z0-9-]+$') {
      Fail-Job 'Internal error: CHANGE_ID is missing or invalid after parse-id.'
    }
    $tasksPath = Join-Path $env:GITHUB_WORKSPACE "openspec/changes/$changeId/tasks.md"
    if (-not (Test-Path -LiteralPath $tasksPath)) {
      Fail-Job "openspec/changes/$changeId/tasks.md was not found on the default branch checkout."
    }
    $tasksText = Get-Content -LiteralPath $tasksPath -Raw -Encoding UTF8
    $blocks = @(Get-TaskBlocks $tasksText)
    if ($blocks.Count -eq 0) {
      Fail-Job "openspec/changes/$changeId/tasks.md has no task entries."
    }

    $selectedIds = @()
    if ($env:TASK_SPEC -and $env:TASK_SPEC.Trim()) {
      if ($env:TASK_SPEC -notmatch '^[0-9.,]+$') {
        Fail-Job 'Malformed tasks: line. It must match ^[0-9.,]+$.'
      }
      $selectedIds = @($env:TASK_SPEC.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      foreach ($tid in $selectedIds) {
        if ($tid -notmatch '^\d+(?:\.\d+)*$') {
          Fail-Job "Malformed task number '$tid'."
        }
        if (-not ($blocks | Where-Object { $_.Id -eq $tid })) {
          Fail-Job "Task $tid was requested but was not found in openspec/changes/$changeId/tasks.md."
        }
      }
    } else {
      $selectedIds = @($blocks | Where-Object { -not $_.Checked } | ForEach-Object { $_.Id })
      if ($selectedIds.Count -eq 0) {
        Fail-Job "No unchecked tasks in openspec/changes/$changeId/tasks.md, and the issue has no tasks: line."
      }
    }

    $allowed = @()
    foreach ($tid in $selectedIds) {
      $block = $blocks | Where-Object { $_.Id -eq $tid } | Select-Object -First 1
      $allowed += @(Get-FilesFromTaskBody $block.Body)
    }
    $allowed = @($allowed | Sort-Object -Unique)
    if ($allowed.Count -eq 0) {
      Fail-Job "tasks.md has no Files: list for the selected tasks ($($selectedIds -join ', '))."
    }
    foreach ($p in $allowed) {
      if (Test-ForbiddenPath $p) {
        Fail-Job "Files: list includes forbidden path '$p'."
      }
    }

    $maxLines = 0
    foreach ($p in $allowed) {
      $full = Join-Path $env:GITHUB_WORKSPACE $p
      if (Test-Path -LiteralPath $full) {
        $lc = (Get-Content -LiteralPath $full -Encoding UTF8).Count
        if ($lc -gt $maxLines) { $maxLines = $lc }
      }
    }
    $editFormat = if ($maxLines -ge 80) { 'diff' } else { 'whole' }

    $wantedScenarios = @()
    foreach ($tid in $selectedIds) {
      $block = $blocks | Where-Object { $_.Id -eq $tid } | Select-Object -First 1
      if ($block) { $wantedScenarios += @(Get-ScenarioNamesFromTaskBody $block.Body) }
    }
    $scenarios = @(Get-ScenarioHeadings -ChangeId $changeId -WantedNames $wantedScenarios)
    $taskNumbers = $selectedIds -join ', '
    Set-Content -LiteralPath $AllowedPath -Value ($allowed -join "`n") -Encoding UTF8
    Set-Content -LiteralPath $ScenarioPath -Value ($scenarios -join "`n") -Encoding UTF8
    Set-Content -LiteralPath $TaskNumsPath -Value $taskNumbers -Encoding UTF8
    Set-JobEnv 'TASK_NUMBERS' $taskNumbers
    Set-JobEnv 'EDIT_FORMAT' $editFormat
    Set-JobEnv 'FILE_COUNT' ([string]$allowed.Count)
    Write-JobLog "Change $changeId tasks $taskNumbers; files $($allowed -join ', '); edit-format $editFormat"

    Push-Location $env:GITHUB_WORKSPACE
    try {
      $branch = "local-builder/issue-$($env:ISSUE_NUMBER)"
      $existing = git ls-remote --heads origin $branch
      if ($existing) {
        Write-JobLog "Branch $branch already exists on origin; recreating it from fresh origin/master."
      }
      git fetch --depth 1 origin master
      if ($LASTEXITCODE -ne 0) { Fail-Job 'git fetch origin master failed.' }
      $baseSha = (git rev-parse origin/master).Trim()
      if ($LASTEXITCODE -ne 0 -or -not $baseSha) { Fail-Job 'git rev-parse origin/master failed.' }
      Set-JobEnv 'LOCAL_BUILDER_BASE' $baseSha
      # Recreate from origin/master so a stale local branch left in .git by a previous
      # failed job cannot block the design.md §6 relabel retry path.
      git checkout -B $branch $baseSha
      if ($LASTEXITCODE -ne 0) { Fail-Job "Failed to create branch $branch from origin/master." }
      Write-JobLog "Created branch $branch from origin/master"
    } finally {
      Pop-Location
    }
  }

  'warmup' {
    $model = $env:MODEL
    $numCtx = $env:NUM_CTX
    if (-not $numCtx) { $numCtx = '4096' }
    $json = '{{"model":"{0}","prompt":"Reply OK","stream":false,"keep_alive":"30m","options":{{"num_ctx":{1}}}}}' -f $model, $numCtx
    $uri = ($env:OLLAMA_API_BASE.TrimEnd('/') + '/api/generate')
    try {
      $resp = Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body $json -TimeoutSec 280
      Write-JobLog "Warm-up complete for $model (num_ctx $numCtx)."
      if ($resp.response) { Write-JobLog ('Warm-up response: ' + (($resp.response | Out-String).Trim().Substring(0, [Math]::Min(80, (($resp.response | Out-String).Trim().Length))))) }
    } catch {
      Fail-Job "Ollama warm-up failed for $model at $uri. $($_.Exception.Message)"
    }
  }

  'render' {
    $prompt = Render-Prompt -Attempt '1' -Excerpt 'none'
    $changeId = $env:CHANGE_ID
    $readAndEdit = @(
      'conventions/CONVENTIONS.md'
      "openspec/changes/$changeId/tasks.md"
    )
    if (Test-Path -LiteralPath $AllowedPath) {
      $readAndEdit += @(Get-Content -LiteralPath $AllowedPath -Encoding UTF8 | Where-Object { $_ })
    }
    $est = Get-EstTokens -Paths $readAndEdit -ExtraText $prompt
    Write-JobLog "Estimated prompt+files tokens: $est (budget 2500)"
    Set-JobEnv 'EST_TOKENS' ([string]$est)
    if ($est -gt 2500) {
      Fail-Job "task too large for 4K context (estimated $est tokens; budget is about 2500)."
    }
  }

  'aider' {
    Add-LocalBinToPath | Out-Null
    if (-not (Get-Command aider -ErrorAction SilentlyContinue)) {
      Fail-Job "aider was not found on PATH for Windows user '$($env:USERNAME)'."
    }
    $attempt = $env:ATTEMPT
    if ($attempt -ne '1' -and $attempt -ne '2') { $attempt = '1' }
    $excerpt = 'none'
    if ($attempt -eq '2' -and (Test-Path -LiteralPath $ExcerptPath)) {
      $excerpt = (Get-Content -LiteralPath $ExcerptPath -Raw -Encoding UTF8).Trim()
      if (-not $excerpt) { $excerpt = 'none' }
    }
    Render-Prompt -Attempt $attempt -Excerpt $excerpt | Out-Null

    $files = @()
    if (Test-Path -LiteralPath $AllowedPath) {
      $files = @(Get-Content -LiteralPath $AllowedPath -Encoding UTF8 | Where-Object { $_ })
    }
    if ($files.Count -eq 0) { Fail-Job 'No allowed files to pass to Aider.' }

    $editFormat = $env:EDIT_FORMAT
    if (-not $editFormat) { $editFormat = 'diff' }
    $model = $env:MODEL
    $aiderLog = Join-Path $env:RUNNER_TEMP "aider-attempt-$attempt.log"
    $aiderArgs = @(
      '--model', "ollama_chat/$model",
      '--edit-format', $editFormat,
      '--no-auto-commits', '--no-dirty-commits', '--yes-always',
      '--no-pretty', '--no-stream', '--no-fancy-input', '--analytics-disable', '--no-check-update',
      '--map-tokens', '0',
      '--timeout', '600',
      '--read', 'conventions/CONVENTIONS.md',
      '--read', "openspec/changes/$($env:CHANGE_ID)/tasks.md",
      '--test-cmd', 'npm test', '--auto-test',
      '--message-file', $PromptPath
    ) + $files

    Write-JobLog "Starting Aider attempt $attempt of 2 (edit-format $editFormat)."
    Push-Location $env:GITHUB_WORKSPACE
    $aiderExit = 0
    try {
      & aider @aiderArgs 2>&1 | Tee-Object -FilePath $aiderLog
      $aiderExit = $LASTEXITCODE
    } catch {
      $aiderExit = 1
      Add-Content -LiteralPath $aiderLog -Value $_.Exception.Message -Encoding UTF8
    } finally {
      Pop-Location
    }
    Write-JobLog "Aider attempt $attempt exited with code $aiderExit"
    Add-Content -LiteralPath $LogPath -Value (Get-TailText -Path $aiderLog -Lines 40) -Encoding UTF8

    $blocked = Join-Path $env:GITHUB_WORKSPACE 'BLOCKED.md'
    if (Test-Path -LiteralPath $blocked) {
      $note = Get-Content -LiteralPath $blocked -Raw -Encoding UTF8
      Fail-Job ("The agent wrote BLOCKED.md:`n`n" + $note.Trim())
    }

    $changed = @(Get-ChangedFiles)
    Write-JobLog ('Changed files: ' + $(if ($changed.Count -gt 0) { $changed -join ', ' } else { '(none)' }))
    if ($attempt -eq '1') {
      Set-JobEnv 'ATTEMPTS_USED' '1'
    } else {
      Set-JobEnv 'ATTEMPTS_USED' '2'
    }
  }

  'evaluate' {
    $blocked = Join-Path $env:GITHUB_WORKSPACE 'BLOCKED.md'
    if (Test-Path -LiteralPath $blocked) {
      Set-JobEnv 'NEED_ATTEMPT_2' 'false'
      $note = Get-Content -LiteralPath $blocked -Raw -Encoding UTF8
      Fail-Job ("The agent wrote BLOCKED.md:`n`n" + $note.Trim())
    }

    $changed = @(Get-ChangedFiles)
    $hasDiff = $changed.Count -gt 0
    $testLog = Join-Path $env:RUNNER_TEMP 'npm-test-attempt1.log'
    $testOk = $false
    if ($hasDiff) {
      Push-Location $env:GITHUB_WORKSPACE
      try {
        cmd /c "npm test > `"$testLog`" 2>&1"
        $testOk = ($LASTEXITCODE -eq 0)
      } finally {
        Pop-Location
      }
      Write-JobLog "npm test after attempt 1: $(if ($testOk) { 'pass' } else { 'fail' })"
      if (-not $testOk) {
        $tail = Get-TailText -Path $testLog -Lines 30
        Set-Content -LiteralPath $ExcerptPath -Value $tail -Encoding UTF8
      }
    } else {
      if (-not (Test-Path -LiteralPath $ExcerptPath) -or -not (Get-Content -LiteralPath $ExcerptPath -Raw -ErrorAction SilentlyContinue)) {
        Set-Content -LiteralPath $ExcerptPath -Value 'no changes produced on attempt 1 (or attempt 1 timed out or failed)' -Encoding UTF8
      }
      Write-JobLog 'No diff after attempt 1.'
    }

    if ($hasDiff -and $testOk) {
      Set-JobEnv 'TESTS_FIRST_TRY' 'yes'
      Set-JobEnv 'NEED_ATTEMPT_2' 'false'
      Set-JobEnv 'ATTEMPTS_USED' '1'
      Write-JobLog 'Attempt 1 produced a passing diff; skipping attempt 2.'
    } else {
      Set-JobEnv 'TESTS_FIRST_TRY' 'no'
      Set-JobEnv 'NEED_ATTEMPT_2' 'true'
      Set-JobEnv 'ATTEMPTS_USED' '1'
      Write-JobLog 'Attempt 1 did not finish with a passing diff; will run attempt 2 if scheduled.'
    }
  }

  'guard' {
    $blocked = Join-Path $env:GITHUB_WORKSPACE 'BLOCKED.md'
    if (Test-Path -LiteralPath $blocked) {
      $note = Get-Content -LiteralPath $blocked -Raw -Encoding UTF8
      Fail-Job ("The agent wrote BLOCKED.md:`n`n" + $note.Trim())
    }

    $allowed = @()
    if (Test-Path -LiteralPath $AllowedPath) {
      $allowed = @(Get-Content -LiteralPath $AllowedPath -Encoding UTF8 | ForEach-Object { Get-NormalizedPath $_ } | Where-Object { $_ })
    }
    $changed = @(Get-ChangedFiles)
    if ($changed.Count -eq 0) {
      Fail-Job 'no changes produced'
    }

    $bad = @()
    foreach ($p in $changed) {
      if (Test-ForbiddenPath $p) { $bad += "forbidden path: $p"; continue }
      if ($allowed -notcontains $p) { $bad += "file not listed in tasks.md Files: $p" }
    }
    if ($bad.Count -gt 0) {
      Fail-Job ("The diff touches files that are not allowed.`n" + ($bad -join "`n") + "`nNothing will be pushed.")
    }

    Push-Location $env:GITHUB_WORKSPACE
    try {
      $testLog = Join-Path $env:RUNNER_TEMP 'npm-test-guard.log'
      cmd /c "npm test > `"$testLog`" 2>&1"
      if ($LASTEXITCODE -ne 0) {
        $tail = Get-TailText -Path $testLog -Lines 40
        Fail-Job ("npm test failed after the agent run.`n`n" + $tail)
      }
      Write-JobLog 'npm test passed.'

      $tscLog = Join-Path $env:RUNNER_TEMP 'tsc-guard.log'
      cmd /c "npx tsc --noEmit > `"$tscLog`" 2>&1"
      if ($LASTEXITCODE -ne 0) {
        $tail = Get-TailText -Path $tscLog -Lines 40
        Fail-Job ("Typecheck (npx tsc --noEmit) failed.`n`n" + $tail)
      }
      Write-JobLog 'Typecheck passed.'
    } finally {
      Pop-Location
    }
  }

  'publish' {
    if (-not $env:GH_TOKEN) { Fail-Job 'GH_TOKEN is missing in the publish step.' }
    $changeId = $env:CHANGE_ID
    $taskNumbers = $env:TASK_NUMBERS
    if (Test-Path -LiteralPath $TaskNumsPath) {
      $taskNumbers = (Get-Content -LiteralPath $TaskNumsPath -Raw -Encoding UTF8).Trim()
    }
    $issue = $env:ISSUE_NUMBER
    $branch = "local-builder/issue-$issue"
    $allowed = @(Get-Content -LiteralPath $AllowedPath -Encoding UTF8 | Where-Object { $_ })
    $attempts = $env:ATTEMPTS_USED
    if (-not $attempts) { $attempts = '2' }
    $firstTry = $env:TESTS_FIRST_TRY
    if (-not $firstTry) { $firstTry = 'no' }
    $editFormat = $env:EDIT_FORMAT
    if (-not $editFormat) { $editFormat = 'unknown' }

    Push-Location $env:GITHUB_WORKSPACE
    try {
      git config --local user.name 'github-actions[bot]'
      git config --local user.email '41898282+github-actions[bot]@users.noreply.github.com'
      $baseRef = Get-BaseRef
      git reset --mixed $baseRef
      if ($LASTEXITCODE -ne 0) { Fail-Job "git reset --mixed $baseRef failed." }
      $toAdd = @()
      foreach ($p in $allowed) {
        $full = Join-Path $env:GITHUB_WORKSPACE $p
        $exists = Test-Path -LiteralPath $full
        $tracked = git ls-files --error-unmatch $p 2>$null
        if ($exists -or $LASTEXITCODE -eq 0) { $toAdd += $p }
      }
      if ($toAdd.Count -eq 0) { Fail-Job 'Nothing to commit after staging allowed files.' }
      git add -- @toAdd
      git diff --cached --quiet
      if ($LASTEXITCODE -eq 0) { Fail-Job 'Nothing to commit after staging allowed files.' }
      $msg = "[local-builder] ${changeId}: tasks ${taskNumbers}"
      # Agent-written hooks must never see the job token: no GH_TOKEN and no hooks during commit.
      $savedToken = $env:GH_TOKEN
      Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
      try {
        git -c core.hooksPath=NUL commit --no-verify -m $msg
        $commitExit = $LASTEXITCODE
      } finally {
        $env:GH_TOKEN = $savedToken
      }
      if ($commitExit -ne 0) { Fail-Job 'git commit failed.' }

      $changed = @(git diff --name-only $baseRef)
      $fileCount = @($changed).Count

      $headerName = 'http.https://github.com/.extraheader'
      $headerValue = "AUTHORIZATION: bearer $($env:GH_TOKEN)"
      git config --local $headerName $headerValue
      try {
        git push "https://github.com/$($env:GITHUB_REPOSITORY).git" "HEAD:refs/heads/$branch"
        if ($LASTEXITCODE -ne 0) { Fail-Job "git push of $branch failed." }
      } finally {
        git config --local --unset $headerName
      }

      $scenarios = @()
      if (Test-Path -LiteralPath $ScenarioPath) {
        $scenarios = @(Get-Content -LiteralPath $ScenarioPath -Encoding UTF8 | Where-Object { $_ })
      }
      $scenarioMd = if ($scenarios.Count -gt 0) { ($scenarios | ForEach-Object { "- $_" }) -join "`n" } else { '- (none found in the change specs)' }
      $runTime = Get-ElapsedText
      $prBody = @"
Opened by the local builder for issue #$issue (``openspec/changes/$changeId``), tasks $taskNumbers.

### Spec scenarios
$scenarioMd

<!-- local-builder-stats -->
### Local builder stats
| Field | Value |
|---|---|
| Model | qwen2.5-coder:7b (num_ctx 4096) |
| Attempts | $attempts of 2 |
| Run time | $runTime |
| Tests passed on first try | $firstTry |
| Edit format | $editFormat |
| Files changed | $fileCount |
| Issue / change | #$issue / openspec/changes/$changeId |
"@
      $payload = @{
        title = "[local-builder] ${changeId}: tasks ${taskNumbers}"
        head  = $branch
        base  = 'master'
        body  = $prBody
      } | ConvertTo-Json -Depth 5
      # PowerShell 5.1 can emit Enum-style capitalization; title/head/base/body are strings only.
      $pr = Invoke-GitHub -Method POST -Uri "https://api.github.com/repos/$($env:GITHUB_REPOSITORY)/pulls" -Body $payload
      Write-JobLog "Opened PR $($pr.html_url)"
      $prNumber = $pr.number
      $labelBody = '{"labels":["local-builder"]}'
      Invoke-GitHub -Method POST -Uri "https://api.github.com/repos/$($env:GITHUB_REPOSITORY)/issues/$prNumber/labels" -Body $labelBody | Out-Null
      try {
        Invoke-GitHub -Method DELETE -Uri "https://api.github.com/repos/$($env:GITHUB_REPOSITORY)/issues/$issue/labels/local-builder-running" | Out-Null
      } catch {
        Write-JobLog 'Could not remove local-builder-running from the issue (it may already be gone).'
      }
    } finally {
      Pop-Location
    }
  }
}
