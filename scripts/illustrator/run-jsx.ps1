# Run an ExtendScript (JSX) file inside the installed Adobe Illustrator through COM
# automation and print whatever the script returns as its last expression.
#
#   powershell -File scripts/illustrator/run-jsx.ps1 -File script.jsx
#   powershell -File scripts/illustrator/run-jsx.ps1 -Code 'return app.version'
#
# The code runs as a function body (use `return`). Illustrator is started when it is not
# running. Errors come back as a line starting with "JSX ERROR:" and exit code 1.
param(
  [string]$File,
  [string]$Code
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ($File) { $Code = [System.IO.File]::ReadAllText((Resolve-Path $File), [System.Text.Encoding]::UTF8) }
if (-not $Code) { Write-Output 'JSX ERROR: pass -File <script.jsx> or -Code <javascript>'; exit 1 }
$prefix = @'
(function () {
  try {
    var __r = (function () {
'@
$suffix = @'

    })();
    return __r === undefined ? '' : String(__r);
  } catch (e) {
    return 'JSX ERROR: ' + (e && e.message ? e.message : e) + (e && e.line ? ' (line ' + e.line + ')' : '');
  }
})();
'@
$wrapped = $prefix + $Code + $suffix
try {
  $app = New-Object -ComObject Illustrator.Application
  $out = $app.DoJavaScript($wrapped)
} catch {
  Write-Output ('JSX ERROR: ' + $_.Exception.Message)
  exit 1
}
Write-Output $out
if ("$out".StartsWith('JSX ERROR:')) { exit 1 }
