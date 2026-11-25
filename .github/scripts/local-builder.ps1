# Local builder build-job script for Windows PowerShell 5.1+ / pwsh.
# Invoked by the self-hosted `build` job in .github/workflows/local-builder.yml with -Step <name>.
# This job runs model-written code and holds no write token. It never pushes, comments, or labels;
# it hands its result to the GitHub-hosted `publish` job as an artifact (see -Step package).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('tools', 'parse-change', 'warmup', 'render', 'aider', 'evaluate', 'guard', 'package')]
  [string]$Step
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-builder-common.ps1')

$ReasonPath = Join-Path $env:RUNNER_TEMP 'local-builder-reason.txt'
$LogPath = Join-Path $env:RUNNER_TEMP 'local-builder.log'
$AllowedPath = Join-Path $env:RUNNER_TEMP 'allowed-files.txt'
$ScenarioPath = Join-Path $env:RUNNER_TEMP 'scenarios.txt'
$ExcerptPath = Join-Path $env:RUNNER_TEMP 'test-failure-excerpt.txt'
$PromptPath = Join-Path $env:RUNNER_TEMP 'job-prompt.md'
$TaskNumsPath = Join-Path $env:RUNNER_TEMP 'task-numbers.txt'
$ResultDir = Join-Path $env:RUNNER_TEMP 'lb-result'

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

function Get-BaseRef {
  # The commit the branch was created from (github.sha, set in parse-change); never local master.
  if ($env:LOCAL_BUILDER_BASE) { return $env:LOCAL_BUILDER_BASE }
  if ($env:GITHUB_SHA) { return $env:GITHUB_SHA }
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

function New-ResultArtifact {
  # Writes manifest.json plus files/<n> (the staged, line-ending-normalized blob of each
  # changed allowed file) to $OutDir. Blobs are named by index so no changed path is ever
  # used as a filename, and upload-artifact's hidden-file exclusion cannot drop one.
  # The publish job re-validates all of it; nothing here is trusted downstream.
  param([string]$Workspace, [string]$BaseSha, [string]$ChangeId, [string[]]$Changed, [hashtable]$Stats, [string]$OutDir)
  if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
  $filesDir = Join-Path $OutDir 'files'
  New-Item -ItemType Directory -Path $filesDir -Force | Out-Null
  $entries = @()
  $i = 0
  Push-Location $Workspace
  try {
    foreach ($p in $Changed) {
      $full = Join-Path $Workspace $p
      if (Test-Path -LiteralPath $full -PathType Leaf) {
        $ErrorActionPreference = 'Continue'
        & git -c core.hooksPath=NUL add -- $p 2>&1 | Out-Null
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) { throw "git add $p failed while packaging." }
        $blobRel = "files/$i"
        $blobFull = Join-Path $filesDir "$i"
        # cmd redirection keeps the bytes exactly; PowerShell 5.1 pipes would re-encode them.
        cmd /c "git cat-file blob "":$p"" > ""$blobFull"""
        if ($LASTEXITCODE -ne 0) { throw "git cat-file for $p failed while packaging." }
        $bytes = [System.IO.File]::ReadAllBytes($blobFull)
        $sha = (Get-FileHash -LiteralPath $blobFull -Algorithm SHA256).Hash.ToLowerInvariant()
        $entries += [ordered]@{ path = $p; op = 'write'; blob = $blobRel; sha256 = $sha; bytes = $bytes.Length }
        $i++
      } else {
        $entries += [ordered]@{ path = $p; op = 'delete' }
      }
    }
  } finally {
    Pop-Location
  }
  $manifest = [ordered]@{
    version   = 1
    base_sha  = $BaseSha
    change_id = $ChangeId
    files     = @($entries)
    stats     = [ordered]@{ attempts = [int]$Stats.attempts; tests_first_try = [string]$Stats.tests_first_try; edit_format = [string]$Stats.edit_format }
  }
  $json = ConvertTo-Json -InputObject $manifest -Depth 6
  [System.IO.File]::WriteAllText((Join-Path $OutDir 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding $false))
  return $manifest
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

function Get-TailText {
  param([string]$Path, [int]$Lines = 40)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $content = Get-Content -LiteralPath $Path -Encoding UTF8
  $tail = $content | Select-Object -Last $Lines
  return (Sanitize-LogText ($tail -join "`n"))
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

    $gitVer = (& git --version 2>&1 | Out-String).Trim()
    Write-JobLog $gitVer

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
      Fail-Job 'Internal error: CHANGE_ID from the start job is missing or invalid.'
    }
    $baseSha = $env:GITHUB_SHA
    if ($baseSha -notmatch '^[0-9a-f]{40}$') { Fail-Job 'Internal error: GITHUB_SHA is missing or invalid.' }
    $tasksPath = Join-Path $env:GITHUB_WORKSPACE "openspec/changes/$changeId/tasks.md"
    if (-not (Test-Path -LiteralPath $tasksPath)) {
      Fail-Job "openspec/changes/$changeId/tasks.md was not found on the default branch checkout."
    }
    $tasksText = Get-Content -LiteralPath $tasksPath -Raw -Encoding UTF8
    try {
      $sel = Resolve-ChangeSelection -TasksText $tasksText -TaskSpec $env:TASK_SPEC -ChangeId $changeId
    } catch {
      Fail-Job $_.Exception.Message
    }
    $allowed = @($sel.Allowed)

    $maxLines = 0
    foreach ($p in $allowed) {
      $full = Join-Path $env:GITHUB_WORKSPACE $p
      if (Test-Path -LiteralPath $full) {
        $lc = (Get-Content -LiteralPath $full -Encoding UTF8).Count
        if ($lc -gt $maxLines) { $maxLines = $lc }
      }
    }
    $editFormat = if ($maxLines -ge 80) { 'diff' } else { 'whole' }

    $scenarios = @(Get-ScenarioHeadings -Root $env:GITHUB_WORKSPACE -ChangeId $changeId -WantedNames $sel.WantedScenarios)
    $taskNumbers = $sel.TaskNumbers
    Set-Content -LiteralPath $AllowedPath -Value ($allowed -join "`n") -Encoding UTF8
    Set-Content -LiteralPath $ScenarioPath -Value ($scenarios -join "`n") -Encoding UTF8
    Set-Content -LiteralPath $TaskNumsPath -Value $taskNumbers -Encoding UTF8
    Set-JobEnv 'TASK_NUMBERS' $taskNumbers
    Set-JobEnv 'EDIT_FORMAT' $editFormat
    Set-JobEnv 'FILE_COUNT' ([string]$allowed.Count)
    Write-JobLog "Change $changeId tasks $taskNumbers; files $($allowed -join ', '); edit-format $editFormat"

    Push-Location $env:GITHUB_WORKSPACE
    try {
      # The branch is local only (publish recreates it on a fresh checkout). Base it on github.sha,
      # the default-branch head when the label was added, which publish also checks out.
      $branch = "local-builder/issue-$($env:ISSUE_NUMBER)"
      Set-JobEnv 'LOCAL_BUILDER_BASE' $baseSha
      git checkout -B $branch $baseSha
      if ($LASTEXITCODE -ne 0) { Fail-Job "Failed to create branch $branch from $baseSha." }
      Write-JobLog "Created local branch $branch from $baseSha"
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

  'package' {
    # Hands the result to the publish job. Everything written here is re-validated there.
    $changed = @(Get-ChangedFiles)
    if ($changed.Count -eq 0) { Fail-Job 'no changes produced' }
    $attempts = if ($env:ATTEMPTS_USED -eq '2') { 2 } else { 1 }
    $firstTry = if ($env:TESTS_FIRST_TRY -eq 'yes') { 'yes' } else { 'no' }
    $editFormat = if ($env:EDIT_FORMAT -eq 'whole') { 'whole' } else { 'diff' }
    try {
      $m = New-ResultArtifact -Workspace $env:GITHUB_WORKSPACE -BaseSha (Get-BaseRef) -ChangeId $env:CHANGE_ID -Changed $changed `
        -Stats @{ attempts = $attempts; tests_first_try = $firstTry; edit_format = $editFormat } -OutDir $ResultDir
    } catch {
      Fail-Job "Packaging the result failed. $($_.Exception.Message)"
    }
    Write-JobLog ("Packaged {0} file(s) for publish: {1}" -f @($m.files).Count, ($changed -join ', '))
  }
}
