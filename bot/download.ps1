<#
.SYNOPSIS
Met à jour le dossier bot dans Téléchargements sans remplacer son fichier .env.

.DESCRIPTION
Télécharge la branche AdsCords de cette session, remplace le contenu du dossier
Téléchargements\bot, restaure le .env local puis réinstalle exactement les dépendances.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Branche AdsCords à récupérer
$repo = 'Snowoo-2z/AdsCords'
$branch = 'arena/9e56519f-adscords'

# Ton dossier bot local
$downloads = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
$destination = Join-Path $downloads 'bot'
$envFile = Join-Path $destination '.env'

if (-not (Test-Path -LiteralPath $destination)) {
    throw "Dossier introuvable : $destination"
}

# Sauvegarde temporaire du .env modifié
$temp = Join-Path $env:TEMP ("AdsCords-update-" + [guid]::NewGuid())
$zip = Join-Path $temp 'adscords.zip'
$envBackup = Join-Path $temp '.env'

try {
    New-Item -ItemType Directory -Path $temp | Out-Null

    if (Test-Path -LiteralPath $envFile) {
        Copy-Item -LiteralPath $envFile -Destination $envBackup -Force
        Write-Host '.env sauvegardé.' -ForegroundColor Yellow
    }
    else {
        Write-Host "Attention : aucun fichier .env trouvé dans $destination" -ForegroundColor Yellow
    }

    # Télécharge la branche GitHub définie ci-dessus.
    Invoke-WebRequest `
        -Uri "https://github.com/$repo/archive/refs/heads/$branch.zip" `
        -OutFile $zip

    Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force

    $archiveRoot = Get-ChildItem -LiteralPath $temp -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bot') } |
        Select-Object -First 1

    if ($null -eq $archiveRoot) {
        throw "Le dossier bot est introuvable dans l'archive téléchargée."
    }

    $sourceBot = Join-Path $archiveRoot.FullName 'bot'

    # Supprime tout dans bot SAUF .env.
    Get-ChildItem -LiteralPath $destination -Force |
        Where-Object { $_.Name -ne '.env' } |
        Remove-Item -Recurse -Force

    # Copie la nouvelle version du bot.
    Get-ChildItem -LiteralPath $sourceBot -Force |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
        }

    # Restaure le .env même si besoin.
    if (Test-Path -LiteralPath $envBackup) {
        Copy-Item -LiteralPath $envBackup -Destination $envFile -Force
    }

    # Réinstalle les dépendances Node exactement comme dans package-lock.json.
    Push-Location $destination
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci a échoué avec le code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    Write-Host "Bot mis à jour avec succès : $destination" -ForegroundColor Green
    Write-Host 'Ton fichier .env a été conservé.' -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $temp) {
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
}
