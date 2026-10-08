<#
.SYNOPSIS
Télécharge uniquement le dossier bot du dépôt public AdsCords.

.DESCRIPTION
Le script récupère l'archive publique GitHub, extrait uniquement le répertoire bot
vers le dossier indiqué puis supprime ses fichiers temporaires. Git n'est pas requis.
#>

[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'Snowoo-2z/AdsCords',

    [ValidateNotNullOrEmpty()]
    [string]$Branch = 'main',

    [ValidateNotNullOrEmpty()]
    [string]$Destination = (Join-Path -Path (Get-Location) -ChildPath 'bot')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (Test-Path -LiteralPath $Destination) {
    throw "Le dossier de destination existe déjà : $Destination`nChoisissez -Destination avec un nouveau chemin pour éviter d'écraser des fichiers."
}

$temporaryDirectory = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("adscords-" + [System.Guid]::NewGuid().ToString('N'))
$archivePath = Join-Path -Path $temporaryDirectory -ChildPath 'adscords.zip'
$encodedBranch = [System.Uri]::EscapeDataString($Branch)
$archiveUrl = "https://github.com/$Repository/archive/refs/heads/$encodedBranch.zip"

try {
    New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null

    Write-Host "Téléchargement de $Repository ($Branch)…"
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath

    Write-Host 'Extraction du dossier bot…'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $temporaryDirectory -Force

    $archiveRoot = Get-ChildItem -LiteralPath $temporaryDirectory -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path -Path $_.FullName -ChildPath 'bot') } |
        Select-Object -First 1

    if ($null -eq $archiveRoot) {
        throw "Le dossier bot est introuvable dans l'archive de la branche '$Branch'."
    }

    $destinationParent = Split-Path -Path $Destination -Parent
    if ($destinationParent) {
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    }

    Copy-Item -LiteralPath (Join-Path -Path $archiveRoot.FullName -ChildPath 'bot') -Destination $Destination -Recurse -Force
    Write-Host "Terminé : $Destination" -ForegroundColor Green
    Write-Host "Ensuite : cd `"$Destination`" ; Copy-Item .env.example .env ; npm ci ; npm start"
}
finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}
