# The four gates, in one call:
#
#   G1  main.py still imports
#   G2  the SET of (path, methods) is unchanged
#   G2b the SHADOWING relationships are unchanged — the thing registration
#       order actually protects, and the thing a sorted() diff cannot see
#   G3  openapi.json is byte-identical (query defaults, response models, and
#       every security dependency, i.e. a dropped require_role guard)
#
# G4 (smoke) is smoke.py and needs a running server.

# Two different directories, and conflating them is how this broke once:
#   $bin  — where the harness scripts live (this folder)
#   $sp   — where their snapshots go (gitignored)
$bin = $PSScriptRoot
$sp = Join-Path $PSScriptRoot "_snapshots"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $root

py -3.10 "$bin\snap.py" after
if ($LASTEXITCODE -ne 0) { Write-Output "G1 FAIL: main.py does not import"; exit 1 }

py -3.10 -c @"
import json, os, sys
sp = r'$sp'
b = json.load(open(os.path.join(sp,'routes_before.json'), encoding='utf-8'))
a = json.load(open(os.path.join(sp,'routes_after.json'), encoding='utf-8'))
ok = True
if b['sorted'] == a['sorted']:
    print('G2  routes      OK   ({} routes)'.format(len(a['sorted'])))
else:
    ok = False
    bs, as_ = set(map(str, b['sorted'])), set(map(str, a['sorted']))
    print('G2  routes      FAIL')
    for x in sorted(bs - as_): print('      lost  ', x)
    for x in sorted(as_ - bs): print('      gained', x)
if b['shadow_pairs'] == a['shadow_pairs']:
    print('G2b shadowing   OK   ({} pair(s), unchanged)'.format(len(a['shadow_pairs'])))
else:
    ok = False
    print('G2b shadowing   FAIL')
    for p in a['shadow_pairs']:
        if p not in b['shadow_pairs']: print('      NEW shadow:', p[0], 'swallows', p[1])
    for p in b['shadow_pairs']:
        if p not in a['shadow_pairs']: print('      gone      :', p[0], 'swallows', p[1])
sys.exit(0 if ok else 1)
"@
$routesOk = ($LASTEXITCODE -eq 0)

git --no-pager diff --no-index --quiet -- "$sp\openapi_before.json" "$sp\openapi_after.json"
if ($LASTEXITCODE -eq 0) {
    Write-Output "G3  openapi     OK   (byte-identical)"
    $openapiOk = $true
} else {
    Write-Output "G3  openapi     FAIL"
    git --no-pager diff --no-index -- "$sp\openapi_before.json" "$sp\openapi_after.json" | Select-Object -First 60
    $openapiOk = $false
}

# Counted as CALL SITES with a multiline-aware regex, not as occurrences of the
# word: most guards are written across two lines
#
#     current_user: models.Pengguna = Depends(
#         require_role(["SUPER_ADMIN", "ADMIN_WILAYAH"])
#     ),
#
# and prose in a docstring must not be able to mask one that went missing.
# A dropped guard turns an admin-only route into an open one while leaving the
# route list identical, so this is a real gate, not bookkeeping.
py -3.10 "$bin\invariants.py"
if ($LASTEXITCODE -ne 0) { Write-Output "GATES FAILED (invariants)"; exit 1 }

# G3b — the only gate that sees a helper left behind in another module. Python
# resolves globals at CALL time, so that failure imports clean, diffs clean, and
# 500s on first request to one endpoint.
$names = py -3.10 tools\check_py_names.py
if ($LASTEXITCODE -ne 0) { Write-Output $names; Write-Output "GATES FAILED (unresolved names)"; exit 1 }
Write-Output "G3b names       OK   (no unresolved globals)"

if ($routesOk -and $openapiOk) { Write-Output "ALL GATES PASS" } else { Write-Output "GATES FAILED"; exit 1 }
