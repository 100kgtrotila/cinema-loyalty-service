param(
    [ValidateSet('status', 'index', 'search')]
    [string]$Action = 'status',
    [string]$Query,
    [ValidateSet('fast', 'moderate', 'full')]
    [string]$Mode = 'full'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$memoryCommand = Get-Command codebase-memory-mcp.exe -ErrorAction Stop
$projectName = $repoRoot -replace '[:\\/]+', '-'
$previousCache = $env:CBM_CACHE_DIR
$previousBudget = $env:CBM_MEM_BUDGET_MB
$previousWorkers = $env:CBM_WORKERS

try {
    $env:CBM_CACHE_DIR = Join-Path $repoRoot '.tmp/codebase-memory'
    $env:CBM_MEM_BUDGET_MB = '256'
    $env:CBM_WORKERS = '2'
    New-Item -ItemType Directory -Path $env:CBM_CACHE_DIR -Force | Out-Null

    switch ($Action) {
        'index' {
            foreach ($setting in @('auto_index', 'auto_watch')) {
                & $memoryCommand.Source config set $setting true | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    throw "Could not enable $setting in the project cache"
                }
            }
            & $memoryCommand.Source cli index_repository --repo-path $repoRoot --name $projectName --mode $Mode --persistence false
        }
        'search' {
            if ([string]::IsNullOrWhiteSpace($Query)) {
                throw 'Provide -Query, for example: -Action search -Query publishPendingIntents'
            }
            & $memoryCommand.Source cli search_graph --project $projectName --query $Query --limit 5
        }
        'status' {
            & $memoryCommand.Source cli index_status --project $projectName
        }
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Codebase Memory exited with code $LASTEXITCODE"
    }
}
finally {
    $env:CBM_CACHE_DIR = $previousCache
    $env:CBM_MEM_BUDGET_MB = $previousBudget
    $env:CBM_WORKERS = $previousWorkers
}
