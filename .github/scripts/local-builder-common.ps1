# Path and task rules shared by the self-hosted build job (local-builder.ps1) and the
# GitHub-hosted publish job (local-builder-publish.ps1), so the two cannot drift.
# Dot-source only. Works on Windows PowerShell 5.1 and pwsh.

# Result-artifact limits checked by the publish job (split-local-builder-publish-job design.md section 10).
$MaxFiles = 10
$MaxBlobBytes = 512KB
$MaxTotalBytes = 1MB
$MaxManifestBytes = 16KB

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

function Get-TaskBlocks {
  param([string]$Text)
  $blocks = @()
  $rx = [regex]'(?m)^-\s+\[([ xX])\]\s+(\d+(?:\.\d+)*)\b.*$'
  $found = $rx.Matches($Text)
  for ($i = 0; $i -lt $found.Count; $i++) {
    $m = $found[$i]
    $start = $m.Index
    $end = if ($i -lt $found.Count - 1) { $found[$i + 1].Index } else { $Text.Length }
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
  # Scenario headings from openspec/changes/<id>/specs under $Root, filtered to $WantedNames
  # when any match. Returns all headings when nothing is wanted or nothing matches.
  param([string]$Root, [string]$ChangeId, [string[]]$WantedNames)
  $headings = @()
  $specsRoot = Join-Path $Root "openspec/changes/$ChangeId/specs"
  if (-not (Test-Path -LiteralPath $specsRoot)) { return $headings }
  $files = Get-ChildItem -LiteralPath $specsRoot -Recurse -Filter '*.md' -File -ErrorAction SilentlyContinue | Sort-Object FullName
  foreach ($f in $files) {
    $text = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
    foreach ($m in [regex]::Matches($text, '(?m)^####\s+Scenario:\s*(.+?)\s*$')) {
      $headings += ('#### Scenario: ' + $m.Groups[1].Value.Trim())
    }
  }
  $wanted = @($WantedNames | Where-Object { $_ } | ForEach-Object { ($_ -replace '^####\s+Scenario:\s*', '').Trim() } | Sort-Object -Unique)
  if ($wanted.Count -eq 0) { return $headings }
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
  if ($filtered.Count -eq 0) { return $headings }
  return $filtered
}

function Resolve-ChangeSelection {
  # Selected task ids, allowed files, and wanted scenario names for a change, from tasks.md text
  # and the optional "tasks:" spec. Throws a plain-language reason on any problem.
  param([string]$TasksText, [string]$TaskSpec, [string]$ChangeId)
  $blocks = @(Get-TaskBlocks $TasksText)
  if ($blocks.Count -eq 0) { throw "openspec/changes/$ChangeId/tasks.md has no task entries." }

  $selectedIds = @()
  if ($TaskSpec -and $TaskSpec.Trim()) {
    if ($TaskSpec -notmatch '^[0-9.,]+$') { throw 'Malformed tasks: line. It must match ^[0-9.,]+$.' }
    $selectedIds = @($TaskSpec.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    foreach ($tid in $selectedIds) {
      if ($tid -notmatch '^\d+(?:\.\d+)*$') { throw "Malformed task number '$tid'." }
      if (-not ($blocks | Where-Object { $_.Id -eq $tid })) {
        throw "Task $tid was requested but was not found in openspec/changes/$ChangeId/tasks.md."
      }
    }
  } else {
    $selectedIds = @($blocks | Where-Object { -not $_.Checked } | ForEach-Object { $_.Id })
    if ($selectedIds.Count -eq 0) {
      throw "No unchecked tasks in openspec/changes/$ChangeId/tasks.md, and the issue has no tasks: line."
    }
  }

  $allowed = @()
  $wantedScenarios = @()
  foreach ($tid in $selectedIds) {
    $block = $blocks | Where-Object { $_.Id -eq $tid } | Select-Object -First 1
    $allowed += @(Get-FilesFromTaskBody $block.Body)
    $wantedScenarios += @(Get-ScenarioNamesFromTaskBody $block.Body)
  }
  $allowed = @($allowed | Sort-Object -Unique)
  if ($allowed.Count -eq 0) { throw "tasks.md has no Files: list for the selected tasks ($($selectedIds -join ', '))." }
  foreach ($p in $allowed) {
    if (Test-ForbiddenPath $p) { throw "Files: list includes forbidden path '$p'." }
  }
  return [pscustomobject]@{
    SelectedIds     = $selectedIds
    TaskNumbers     = ($selectedIds -join ', ')
    Allowed         = $allowed
    WantedScenarios = $wantedScenarios
  }
}

function Sanitize-LogText {
  param([string]$Text)
  if (-not $Text) { return '' }
  $t = $Text
  $t = [regex]::Replace($t, '(?i)(Bearer\s+)[^\s]+', '$1[redacted]')
  $t = [regex]::Replace($t, '(?i)(gh[pousr]_[A-Za-z0-9]+)', '[redacted]')
  $t = [regex]::Replace($t, '(?i)github_pat_[A-Za-z0-9_]+', '[redacted]')
  $lines = $t -split '\r?\n' | ForEach-Object { $_ -replace '^(\s*)::', '$1 :' }
  return ($lines -join "`n")
}
