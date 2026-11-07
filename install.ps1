[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$configRoot = Join-Path $env:USERPROFILE '.gemini\config'
$dest = Join-Path $configRoot 'plugins\qa-annotator'
$configFile = Join-Path $configRoot 'config.json'

$running = @(Get-Process | Where-Object { $_.ProcessName -match '^Antigravity' })
if ($running.Count -gt 0 -and -not $Force) {
    throw 'Cierra Antigravity antes de instalar (o usa -Force si sabes lo que haces).'
}

if (Test-Path -LiteralPath $dest) {
    Remove-Item -LiteralPath $dest -Recurse -Force
}
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $dest -Recurse -Force
Write-Output "Plugin copiado a: $dest"

if (-not (Test-Path -LiteralPath $configFile)) {
    Write-Output "No existe $configFile; abre Antigravity una vez y vuelve a ejecutar."
    exit 0
}

$backup = "$configFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $configFile -Destination $backup -Force
$doc = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json

if (-not $doc.PSObject.Properties['sidecars']) {
    $doc | Add-Member -NotePropertyName 'sidecars' -NotePropertyValue ([pscustomobject]@{})
}

$key = 'qa-annotator/annotator'
$existing = $doc.sidecars.PSObject.Properties[$key]
if ($existing) {
    $existing.Value.enabled = $true
    if (-not $existing.Value.PSObject.Properties['schemaVersion']) {
        $existing.Value | Add-Member -NotePropertyName 'schemaVersion' -NotePropertyValue 1
    }
} else {
    $doc.sidecars | Add-Member -NotePropertyName $key -NotePropertyValue ([pscustomobject]@{
        enabled = $true
        schemaVersion = 1
    })
}

$json = $doc | ConvertTo-Json -Depth 40
[System.IO.File]::WriteAllText($configFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "Sidecar habilitado en: $configFile (backup: $backup)"
Write-Output ''
Write-Output 'Siguiente:'
Write-Output '  1. Abre Antigravity.'
Write-Output '  2. Customizations > Installed > QA Annotator (verifica que este activo).'
Write-Output '  3. En una conversacion, abre el panel QA Annotator en la barra lateral.'
Write-Output '  4. Pide: "prepara una sesion de QA para http://localhost:3000".'
