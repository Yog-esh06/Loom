[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$venvPython = Join-Path $backend ".venv\Scripts\python.exe"
$viteCli = Join-Path $frontend "node_modules\vite\bin\vite.js"
$logDir = Join-Path $root ".loom\logs"
$apiUrl = "http://127.0.0.1:8000"
$webUrl = "http://127.0.0.1:5173"
$children = @()
$previousDatabaseUrl = $env:DATABASE_URL
$previousCorsOrigins = $env:CORS_ORIGINS

function Test-HttpReady([string]$Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Stop-LoomChildren {
    foreach ($childId in $children) {
        $child = Get-Process -Id $childId -ErrorAction SilentlyContinue
        if ($child) {
            Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
        }
    }
}

try {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $pythonCommand -or -not $nodeCommand -or -not $npmCommand) {
        throw "Install Python 3.11+, Node.js 22+, and npm, then run this command again."
    }

    $pythonVersion = & $pythonCommand.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
    $pythonParts = $pythonVersion.Split(".")
    if ([int]$pythonParts[0] -lt 3 -or ([int]$pythonParts[0] -eq 3 -and [int]$pythonParts[1] -lt 11)) {
        throw "Python 3.11 or newer is required. Detected Python $pythonVersion."
    }
    $nodeMajor = [int]((& $nodeCommand.Source --version).TrimStart("v").Split(".")[0])
    if ($nodeMajor -lt 22) {
        throw "Node.js 22 or newer is required. Detected Node.js $nodeMajor."
    }

    foreach ($port in @(8000, 5173)) {
        $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($listener) {
            throw "Port $port is already in use. Stop the existing service and run .\run.ps1 again."
        }
    }

    if (-not (Test-Path -LiteralPath $venvPython)) {
        Write-Host "Creating the LOOM Python environment..." -ForegroundColor Cyan
        & $pythonCommand.Source -m venv (Join-Path $backend ".venv")
        if ($LASTEXITCODE -ne 0) {
            throw "Creating the Python environment failed with exit code $LASTEXITCODE."
        }
    }

    $dependenciesReady = & $venvPython -c "import fastapi, pydantic_settings, sqlalchemy, jwt, pwdlib" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Installing LOOM backend dependencies..." -ForegroundColor Cyan
        & $venvPython -m pip install -e $backend
        if ($LASTEXITCODE -ne 0) {
            throw "Installing Python dependencies failed with exit code $LASTEXITCODE."
        }
    }

    if (-not (Test-Path -LiteralPath $viteCli)) {
        Write-Host "Installing LOOM frontend dependencies..." -ForegroundColor Cyan
        Push-Location $frontend
        try {
            & $npmCommand.Source ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) {
                throw "Installing frontend dependencies failed with exit code $LASTEXITCODE."
            }
        }
        finally {
            Pop-Location
        }
    }

    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $env:DATABASE_URL = "sqlite:///./loom.db"
    $env:CORS_ORIGINS = "http://127.0.0.1:5173,http://localhost:5173"

    $apiOut = Join-Path $logDir "api.out.log"
    $apiErr = Join-Path $logDir "api.err.log"
    $webOut = Join-Path $logDir "web.out.log"
    $webErr = Join-Path $logDir "web.err.log"

    $apiProcess = Start-Process -FilePath $venvPython `
        -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000") `
        -WorkingDirectory $backend -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $apiOut -RedirectStandardError $apiErr
    $children += $apiProcess.Id

    $webProcess = Start-Process -FilePath $nodeCommand.Source `
        -ArgumentList "`"$viteCli`" --host 127.0.0.1 --strictPort" `
        -WorkingDirectory $frontend -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $webOut -RedirectStandardError $webErr
    $children += $webProcess.Id

    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        $apiProcess.Refresh()
        $webProcess.Refresh()
        if ($apiProcess.HasExited) {
            throw "LOOM API exited during startup. Check $apiErr"
        }
        if ($webProcess.HasExited) {
            throw "LOOM frontend exited during startup. Check $webErr"
        }
        if ((Test-HttpReady "$apiUrl/health") -and (Test-HttpReady $webUrl)) {
            break
        }
        Start-Sleep -Milliseconds 500
    }

    if (-not (Test-HttpReady "$apiUrl/health") -or -not (Test-HttpReady $webUrl)) {
        throw "LOOM did not become ready within 60 seconds. Check logs in $logDir"
    }

    Write-Host ""
    Write-Host "LOOM is ready." -ForegroundColor Green
    Write-Host "Workspace: $webUrl"
    Write-Host "API docs:  $apiUrl/docs"
    Write-Host "Logs:      $logDir"
    Write-Host "Press Ctrl+C to stop the frontend and backend."
    if (-not $NoBrowser) {
        Start-Process $webUrl
    }

    while ($true) {
        $apiProcess.Refresh()
        $webProcess.Refresh()
        if ($apiProcess.HasExited) {
            throw "LOOM API stopped. Check $apiErr"
        }
        if ($webProcess.HasExited) {
            throw "LOOM frontend stopped. Check $webErr"
        }
        Start-Sleep -Seconds 1
    }
}
finally {
    Stop-LoomChildren
    $env:DATABASE_URL = $previousDatabaseUrl
    $env:CORS_ORIGINS = $previousCorsOrigins
}
