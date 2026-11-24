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
function Git { & git @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $args failed" } }

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
  Git init -q -b master
  Git config user.email t@example.com
  Git config user.name t
  Set-Content a.txt 'base'
  Git add a.txt
  Git commit -q -m base
  $base = (git rev-parse HEAD).Trim()
  $leak = Join-Path $tmp 'leak.txt'
  Set-Content (Join-Path $tmp '.git/hooks/pre-commit') "#!/bin/sh`necho `$GH_TOKEN > '$leak'`n"
  if ($IsLinux -or $IsMacOS) { chmod +x (Join-Path $tmp '.git/hooks/pre-commit') }
  Set-Content b.txt 'x'
  Git add b.txt
  $env:GH_TOKEN = 'secret'
  $saved = $env:GH_TOKEN
  Remove-Item Env:GH_TOKEN
  Check 'GH_TOKEN absent during commit' (-not $env:GH_TOKEN)
  git -c core.hooksPath=NUL commit --no-verify -q -m t 2>&1 | Out-Null
  $env:GH_TOKEN = $saved
  Check 'commit succeeded' ($LASTEXITCODE -eq 0)
  Check 'pre-commit hook did not run' (-not (Test-Path $leak))
  Remove-Item Env:GH_TOKEN

  # 5/6. Base ref: local master behind origin/master, existing branch recreated
  Git checkout -q -b local-builder/issue-1
  Git checkout -q master
  Set-Content c.txt 'upstream'
  Git add c.txt
  Git commit -q -m upstream
  $fresh = (git rev-parse HEAD).Trim()
  Git checkout -q local-builder/issue-1
  Git branch -q -f master $base            # local master is stale
  Git checkout -q -B local-builder/issue-1 $fresh   # relabel retry recreates the branch
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

if ($fails -gt 0) { Write-Host "$fails check(s) failed"; exit 1 }
Write-Host 'all checks passed'
