Describe 'Secure Close extension static policy' {
    BeforeAll {
        $extensionSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\extension'))
        $verifier = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\scripts\verify-extension.ps1'))

        function New-Candidate {
            $candidate = Join-Path $TestDrive ([Guid]::NewGuid().ToString('N'))
            Copy-Item -LiteralPath $extensionSource -Destination $candidate -Recurse
            return $candidate
        }

        function Read-CandidateText([string]$Candidate, [string]$RelativePath) {
            return [IO.File]::ReadAllText((Join-Path $Candidate $RelativePath), [Text.Encoding]::UTF8)
        }

        function Write-CandidateText([string]$Candidate, [string]$RelativePath, [string]$Text) {
            [IO.File]::WriteAllText((Join-Path $Candidate $RelativePath), $Text, [Text.UTF8Encoding]::new($false))
        }

        function Invoke-Policy([string]$Candidate) {
            $output = (& pwsh -NoProfile -File $verifier -ExtensionRoot $Candidate 2>&1 | Out-String)
            [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
        }

        function Assert-PolicyPass([string]$Candidate) {
            $result = Invoke-Policy $Candidate
            $result.ExitCode | Should -Be 0
            $result.Output | Should -Match 'verify-extension OK'
        }

        function Assert-PolicyFail([string]$Candidate, [string]$Reason) {
            $result = Invoke-Policy $Candidate
            $result.ExitCode | Should -Not -Be 0
            $result.Output | Should -Match $Reason
        }
    }

    It 'accepts the final candidate with one exact placeholder' {
        Assert-PolicyPass (New-Candidate)
    }

    It 'accepts a candidate with zero placeholders' {
        $candidate = New-Candidate
        $html = Read-CandidateText $candidate 'options\options.html'
        Write-CandidateText $candidate 'options\options.html' ($html -replace ' placeholder="https://example\.com"', '')
        Assert-PolicyPass $candidate
    }

    It 'rejects a second placeholder in the existing options file' {
        $candidate = New-Candidate
        $html = Read-CandidateText $candidate 'options\options.html'
        Write-CandidateText $candidate 'options\options.html' ($html + '<input placeholder="https://example.com">')
        Assert-PolicyFail $candidate 'placeholder allowlist count'
    }

    It 'rejects single-quoted placeholder syntax' {
        $candidate = New-Candidate
        $html = Read-CandidateText $candidate 'options\options.html'
        Write-CandidateText $candidate 'options\options.html' ($html -replace 'placeholder="https://example\.com"', "placeholder='https://example.com'")
        Assert-PolicyFail $candidate 'forbidden source pattern: https\?://'
    }

    It 'rejects a placeholder in another existing extension file' {
        $candidate = New-Candidate
        $popup = Read-CandidateText $candidate 'popup\popup.html'
        Write-CandidateText $candidate 'popup\popup.html' ($popup + '<input placeholder="https://example.com">')
        Assert-PolicyFail $candidate 'placeholder allowlist is restricted'
    }

    It 'rejects href, text, evil URL, and executable URL literals' {
        $cases = @(
            @{ Relative = 'popup\popup.html'; Text = '<a href="https://example.com">x</a>'; Reason = 'forbidden source pattern: https\?://' },
            @{ Relative = 'options\options.html'; Text = '<p>https://example.com</p>'; Reason = 'forbidden source pattern: https\?://' },
            @{ Relative = 'options\options.html'; Text = 'https://evil.example/x'; Reason = 'forbidden source pattern: https\?://' },
            @{ Relative = 'background.js'; Text = "fetch('https://example.com')"; Reason = 'forbidden source pattern: https\?://' }
        )
        foreach ($case in $cases) {
            $candidate = New-Candidate
            $source = Read-CandidateText $candidate $case.Relative
            Write-CandidateText $candidate $case.Relative ($source + "`n" + $case.Text)
            Assert-PolicyFail $candidate $case.Reason
        }
    }

    It 'rejects placeholder lookalikes outside the exact input context' {
        $cases = @(
            @{ Text = '<input id="origin-input" type="text" data-placeholder="https://example.com" autocomplete="off">'; Reason = 'requires the exact origin-input' },
            @{ Text = "<script>`n<input id=`"origin-input`" type=`"text`" placeholder=`"https://example.com`" autocomplete=`"off`">`n</script>"; Reason = 'forbidden inside script' },
            @{ Text = '<!-- <input id="origin-input" type="text" placeholder="https://example.com" autocomplete="off"> -->'; Reason = 'forbidden inside script or comment' }
        )
        foreach ($case in $cases) {
            $candidate = New-Candidate
            $html = Read-CandidateText $candidate 'options\options.html'
            Write-CandidateText $candidate 'options\options.html' ($html -replace '<input id="origin-input" type="text" placeholder="https://example\.com" autocomplete="off">', '')
            $html = Read-CandidateText $candidate 'options\options.html'
            Write-CandidateText $candidate 'options\options.html' ($html + "`n" + $case.Text)
            Assert-PolicyFail $candidate $case.Reason
        }
    }

    It 'rejects malformed command contracts with a specific reason' {
        $cases = @(
            @{ Kind = 'missing'; Reason = 'commands is required' },
            @{ Kind = 'extra'; Reason = 'commands must contain _execute_action only' },
            @{ Kind = 'action-null'; Reason = '_execute_action must be an object' },
            @{ Kind = 'global'; Reason = 'must not define global' },
            @{ Kind = 'suggested'; Reason = 'suggested_key is required' },
            @{ Kind = 'suggested-null'; Reason = 'suggested_key.default is required' },
            @{ Kind = 'default'; Reason = 'suggested_key.default is required' },
            @{ Kind = 'shortcut'; Reason = 'must be Alt\+Shift\+C' }
        )
        foreach ($case in $cases) {
            $candidate = New-Candidate
            $manifestObject = Get-Content -LiteralPath (Join-Path $candidate 'manifest.json') -Raw | ConvertFrom-Json -Depth 20
            switch ($case.Kind) {
                'missing' { $manifestObject.PSObject.Properties.Remove('commands') }
                'extra' { $manifestObject.commands | Add-Member -NotePropertyName extra -NotePropertyValue ([pscustomobject]@{}) }
                'action-null' { $manifestObject.commands._execute_action = $null }
                'global' { $manifestObject.commands._execute_action | Add-Member -NotePropertyName global -NotePropertyValue $true }
                'suggested' { $manifestObject.commands._execute_action.PSObject.Properties.Remove('suggested_key') }
                'suggested-null' { $manifestObject.commands._execute_action.suggested_key = $null }
                'default' { $manifestObject.commands._execute_action.suggested_key.PSObject.Properties.Remove('default') }
                'shortcut' { $manifestObject.commands._execute_action.suggested_key.default = 'Ctrl+Shift+X' }
            }
            Write-CandidateText $candidate 'manifest.json' ($manifestObject | ConvertTo-Json -Depth 20)
            Assert-PolicyFail $candidate $case.Reason
        }
    }

    It 'rejects APIs outside the explicit allowlist' {
        $candidate = New-Candidate
        $source = Read-CandidateText $candidate 'background.js'
        Write-CandidateText $candidate 'background.js' ($source + "`nvoid chromeApi.runtime.connect('x');")
        Assert-PolicyFail $candidate 'Chrome API outside allowlist'
    }
}
