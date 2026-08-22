"""
Negative controls for tools/check_html.py.

A checker that has never failed is a checker nobody has tested. This breaks
index.html in five specific ways — one per check — confirms the corresponding
check reports it, and restores the file every time.
"""

import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
INDEX = os.path.join(ROOT, "index.html")

CASES = [
    (
        "1 view with no nav button",
        '<button data-view="laporan"',
        '<button data-viewX="laporan"',
        "view-laporan",
    ),
    (
        "2 modal with no close control",
        'id="close-qr-modal"',
        'id="qr-modal-nope"',
        "qr-modal",
    ),
    (
        "3 duplicate id",
        'id="search-db"',
        'id="search-afkir"',
        "search-afkir",
    ),
    (
        "4 table-stack without a thead",
        '<table class="table-stack w-full text-[11px]">\n                                            <thead>',
        '<table class="table-stack w-full text-[11px]">\n                                            <thead-x>',
        "table-stack",
    ),
    (
        "5 deferred js/ script",
        '<script src="js/core.js"></script>',
        '<script defer src="js/core.js"></script>',
        "defer",
    ),
]


def main():
    backup = os.path.join(tempfile.gettempdir(), "index_negcheck_backup.html")
    shutil.copy2(INDEX, backup)
    original = open(INDEX, encoding="utf-8").read()

    ok = True
    try:
        for label, find, repl, expect in CASES:
            if find not in original:
                print(f"  SKIP {label}: anchor not found in index.html")
                ok = False
                continue
            broken = original.replace(find, repl, 1)
            open(INDEX, "w", encoding="utf-8").write(broken)
            r = subprocess.run(
                [sys.executable, os.path.join(ROOT, "tools", "check_html.py")],
                capture_output=True, text=True, cwd=ROOT,
            )
            caught = r.returncode != 0 and expect in r.stdout
            print(f"  {'ok  ' if caught else 'MISS'} {label}"
                  f"{'' if caught else f'  (rc={r.returncode})'}")
            if not caught:
                ok = False
                print("        " + "\n        ".join(r.stdout.strip().splitlines()[-6:]))
    finally:
        open(INDEX, "w", encoding="utf-8").write(original)

    # Prove the restore worked.
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tools", "check_html.py")],
        capture_output=True, text=True, cwd=ROOT,
    )
    print(f"\n  restored: check_html.py exits {r.returncode} (want 0)")
    same = open(INDEX, encoding="utf-8").read() == original
    print(f"  index.html byte-identical to the original: {same}")
    return 0 if (ok and r.returncode == 0 and same) else 1


if __name__ == "__main__":
    sys.exit(main())
