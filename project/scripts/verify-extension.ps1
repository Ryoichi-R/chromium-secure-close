#requires -Version 7.4
[CmdletBinding()]
param(
    [string]$ExtensionRoot = (Join-Path $PSScriptRoot '..\extension')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$extensionRoot = [IO.Path]::GetFullPath($ExtensionRoot)
if (-not (Test-Path -LiteralPath $extensionRoot -PathType Container)) { throw "Extension root not found: $extensionRoot" }

$errors = [System.Collections.Generic.List[string]]::new()
function Fail([string]$Message) { $errors.Add($Message) }
function Read-Text([string]$Path) { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) }
function Relative([string]$Path) { return [IO.Path]::GetRelativePath($extensionRoot, $Path).Replace('\', '/') }
function Test-ManifestReference([string]$Reference, [string]$Field) {
    if ([string]::IsNullOrWhiteSpace($Reference)) { Fail "manifest reference is empty: $Field"; return }
    $candidate = [IO.Path]::GetFullPath((Join-Path $extensionRoot $Reference))
    $rootWithSeparator = $extensionRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
        Fail "manifest reference escapes extension root: $Field=$Reference"
        return
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { Fail "manifest reference missing: $Field=$Reference" }
}

$manifestPath = Join-Path $extensionRoot 'manifest.json'
$manifest = $null
try { $manifest = (Read-Text $manifestPath) | ConvertFrom-Json -Depth 20 } catch { Fail "manifest.json is not valid JSON: $($_.Exception.Message)" }
if ($manifest) {
    $permissions = @($manifest.permissions | ForEach-Object { [string]$_ } | Sort-Object)
    if ((($permissions -join ',') -ne 'browsingData,storage')) { Fail "permissions must be browsingData,storage only: $($permissions -join ',')" }
    if ([string]$manifest.incognito -ne 'spanning') { Fail "manifest.incognito must be spanning: $($manifest.incognito)" }
    foreach ($forbidden in @('host_permissions', 'optional_host_permissions', 'content_scripts', 'externally_connectable', 'web_accessible_resources', 'update_url', 'sandbox')) {
        if ($manifest.PSObject.Properties.Name -contains $forbidden) { Fail "forbidden manifest key: $forbidden" }
    }
    $csp = [string]$manifest.content_security_policy.extension_pages
    $normalizedCsp = (($csp -replace '\s+', ' ').Trim()).TrimEnd(';')
    $expectedCsp = "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
    if ($normalizedCsp -ne $expectedCsp) { Fail "CSP must exactly match the local-only policy: $expectedCsp" }

    Test-ManifestReference ([string]$manifest.background.service_worker) 'background.service_worker'
    Test-ManifestReference ([string]$manifest.action.default_popup) 'action.default_popup'
    Test-ManifestReference ([string]$manifest.options_page) 'options_page'
    foreach ($property in $manifest.action.default_icon.PSObject.Properties) {
        Test-ManifestReference ([string]$property.Value) "action.default_icon.$($property.Name)"
    }
    foreach ($property in $manifest.icons.PSObject.Properties) {
        Test-ManifestReference ([string]$property.Value) "icons.$($property.Name)"
    }

    if (-not ($manifest.PSObject.Properties.Name -contains 'commands')) {
        Fail 'commands is required and must contain _execute_action only'
    } else {
        $commandProperties = @($manifest.commands.PSObject.Properties)
        if ($commandProperties.Count -ne 1 -or $commandProperties[0].Name -ne '_execute_action') {
            Fail 'commands must contain _execute_action only'
        } else {
            $action = $manifest.commands._execute_action
            if ($null -eq $action) {
                Fail 'commands._execute_action must be an object'
            } else {
                $actionPropertyNames = @($action.PSObject.Properties | ForEach-Object { $_.Name })
                if ($actionPropertyNames -contains 'global') { Fail 'commands._execute_action must not define global' }
                if ($actionPropertyNames -notcontains 'suggested_key') {
                    Fail 'commands._execute_action.suggested_key is required'
                } else {
                    $suggestedKey = $action.suggested_key
                    if ($null -eq $suggestedKey) {
                        Fail 'commands._execute_action.suggested_key.default is required'
                    } else {
                        $suggestedKeyPropertyNames = @($suggestedKey.PSObject.Properties | ForEach-Object { $_.Name })
                        if ($suggestedKeyPropertyNames -notcontains 'default') {
                            Fail 'commands._execute_action.suggested_key.default is required'
                        } elseif ([string]$suggestedKey.default -ne 'Alt+Shift+C') {
                            Fail 'commands._execute_action.suggested_key.default must be Alt+Shift+C'
                        }
                    }
                }
            }
        }
    }
}

$cleanerPath = Join-Path $extensionRoot 'lib/cleaner.js'
if (Test-Path -LiteralPath $cleanerPath -PathType Leaf) {
    $cleanerSource = Read-Text $cleanerPath
    if (-not [regex]::IsMatch($cleanerSource, 'originTypes\s*:\s*\{\s*unprotectedWeb\s*:\s*true\s*\}')) {
        Fail 'cleaner must pin originTypes to { unprotectedWeb: true }'
    }
    if ([regex]::IsMatch($cleanerSource, 'originTypes\s*:\s*\{[^}]*\b(?:protectedWeb|extension)\b')) {
        Fail 'cleaner must not enable protectedWeb or extension originTypes'
    }
}

$expectedFiles = @(
    'manifest.json', 'background.js',
    'lib/settings.js', 'lib/cleaner.js', 'lib/run-state.js', 'lib/secure-close.js', 'lib/view-model.js',
    'popup/popup.html', 'popup/popup.css', 'popup/popup.js',
    'options/options.html', 'options/options.css', 'options/options.js',
    'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'
)
$actualFiles = @(Get-ChildItem -LiteralPath $extensionRoot -File -Recurse | ForEach-Object { Relative $_.FullName } | Sort-Object)
foreach ($file in $expectedFiles) { if ($actualFiles -notcontains $file) { Fail "missing or unlisted expected file: $file" } }
foreach ($file in $actualFiles) { if ($expectedFiles -notcontains $file) { Fail "unexpected extension file: $file" } }

$sourceFiles = @(Get-ChildItem -LiteralPath $extensionRoot -File -Recurse | Where-Object { $_.Extension -in @('.js', '.html', '.css', '.json') })
$placeholderPattern = 'placeholder="https://example\.com"'
$allowedPlaceholderLinePattern = '(?m)^[ \t]*<input id="origin-input" type="text" placeholder="https://example\.com" autocomplete="off">[ \t]*$'
$sourceParts = [System.Collections.Generic.List[string]]::new()
foreach ($file in $sourceFiles) {
    $relative = Relative $file.FullName
    $text = Read-Text $file.FullName
    $placeholderMatches = [regex]::Matches($text, $placeholderPattern)
    $allowedPlaceholderMatches = [regex]::Matches($text, $allowedPlaceholderLinePattern)
    if ($placeholderMatches.Count -gt 0 -and $relative -ne 'options/options.html') {
        Fail "placeholder allowlist is restricted to options/options.html: $relative"
    }
    if ($relative -eq 'options/options.html' -and $placeholderMatches.Count -gt 1) {
        Fail "placeholder allowlist count must be 0 or 1: $relative=$($placeholderMatches.Count)"
    }
    if ($relative -eq 'options/options.html') {
        $blockedHtmlRanges = @([regex]::Matches($text, '(?is)<script\b[^>]*>.*?</script>|<!--.*?-->'))
        foreach ($placeholderMatch in $placeholderMatches) {
            if ($blockedHtmlRanges | Where-Object { $placeholderMatch.Index -ge $_.Index -and $placeholderMatch.Index -lt ($_.Index + $_.Length) }) {
                Fail 'placeholder allowlist is forbidden inside script or comment content'
            }
        }
        if ($placeholderMatches.Count -ne $allowedPlaceholderMatches.Count) {
            Fail 'placeholder allowlist requires the exact origin-input text placeholder context'
        }
        $text = [regex]::Replace($text, $allowedPlaceholderLinePattern, {
                param($match)
                $match.Value.Replace('https://example.com', 'ORIGIN_PLACEHOLDER_EXAMPLE')
            })
    }
    $sourceParts.Add($text)
}
$source = $sourceParts -join "`n"
$allowedApi = @(
    'chrome.runtime.id', 'chrome.runtime.onMessage.addListener', 'chrome.runtime.sendMessage',
    'chrome.storage.local.get', 'chrome.storage.local.set', 'chrome.windows.getAll',
    'chrome.windows.getCurrent', 'chrome.windows.remove', 'chrome.browsingData.remove',
    'chromeApi.runtime.lastError', 'chromeApi.runtime.lastError.message', 'chromeApi.runtime.sendMessage', 'chromeApi.runtime.onMessage.addListener', 'chromeApi.storage.local', 'chromeApi.storage.local.get',
    'chromeApi.storage.local.set', 'chromeApi.windows.getCurrent', 'chromeApi.runtime.openOptionsPage', 'api.storage.local',
    'api.runtime.id', 'api.runtime.onMessage.addListener', 'api.browsingData.remove', 'api.windows.getAll', 'api.windows.remove',
    'globalThis.chrome?.runtime', 'globalThis.chrome?.storage'
)
$apiMatches = [regex]::Matches($source, '(?:chrome|chromeApi|api|globalThis\.chrome\?)\.(?:runtime|storage|windows|browsingData)\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?')
foreach ($match in $apiMatches) {
    $api = $match.Value.TrimEnd(')', ';', ',', '.')
    if ($allowedApi -notcontains $api) { Fail "Chrome API outside allowlist: $api" }
}
foreach ($pattern in @(
    '(?:chrome|chromeApi|api|globalThis\.chrome\?)\.tabs\.', '(?:chrome|chromeApi|api|globalThis\.chrome\?)\.windows\.create', '(?:chrome|chromeApi|api|globalThis\.chrome\?)\.storage\.sync', '(?:chrome|chromeApi|api|globalThis\.chrome\?)\.runtime\.(?:connect|sendMessage)\s*\(\s*["'']',
    '\bwindow\.open\s*\(', '\blocation\s*(?:\.|=)', 'https?://', '\bimportScripts\s*\(',
    '\bfetch\s*\(', '\bXMLHttpRequest\b', '\bWebSocket\b', '\bEventSource\b', '\bsendBeacon\s*\(',
    '\beval\s*\(', '\bnew\s+Function\s*\(', 'from\s*["'']https?://',
    '\bimport\s*\(',
    '(?m)^\s*import\s*["''](?!\.{1,2}/)',
    '(?m)^\s*(?:import|export)\b[^;\r\n]*\bfrom\s*["''](?!\.{1,2}/)',
    '\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b', '\bpasswords\b'
)) {
    if ([regex]::IsMatch($source, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) { Fail "forbidden source pattern: $pattern" }
}

$declaredIcons = @(
    @{ Size = 16; Path = [string]$manifest.icons.'16' },
    @{ Size = 32; Path = [string]$manifest.icons.'32' },
    @{ Size = 48; Path = [string]$manifest.icons.'48' },
    @{ Size = 128; Path = [string]$manifest.icons.'128' }
)
function Read-BE32([byte[]]$Bytes, [int]$Offset) { return ([uint32]$Bytes[$Offset] -shl 24) -bor ([uint32]$Bytes[$Offset + 1] -shl 16) -bor ([uint32]$Bytes[$Offset + 2] -shl 8) -bor [uint32]$Bytes[$Offset + 3] }
foreach ($icon in $declaredIcons) {
    $path = Join-Path $extensionRoot $icon.Path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "icon missing: $($icon.Path)"; continue }
    $bytes = [IO.File]::ReadAllBytes($path)
    if ($bytes.Length -lt 33 -or ([Convert]::ToHexString($bytes[0..7]) -ne '89504E470D0A1A0A')) { Fail "invalid PNG signature: $($icon.Path)"; continue }
    $width = Read-BE32 $bytes 16
    $height = Read-BE32 $bytes 20
    if ($width -ne $icon.Size -or $height -ne $icon.Size) { Fail "PNG dimensions mismatch for $($icon.Path): ${width}x${height}" }
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_ }
    throw "verify-extension failed with $($errors.Count) error(s)"
}
Write-Output "verify-extension OK: $extensionRoot"
