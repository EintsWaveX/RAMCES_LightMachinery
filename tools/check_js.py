"""
Structural checks for the js/ frontend.

    py -3.10 tools/check_js.py

There is no Node.js on this machine, so `node --check` and every linter that
depends on it are unavailable. This stands in for them. It does not type-check
or evaluate anything — it catches the three failures that a large mechanical
edit to js/ actually causes, all of which are invisible until the page is
opened and by then present as a blank screen:

  1. Unbalanced brackets, from a bad cut or a mis-paired edit.
  2. The SAME top-level `let`/`const`/`function` declared in two files. The
     files are classic scripts sharing one global lexical environment, so this
     is a fatal SyntaxError that kills the whole page — and nothing warns you.
  3. A call to something that is declared nowhere, i.e. a function lost in a
     move.

Exit code is non-zero if anything fails, so it can gate a commit hook.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jslex

JS_DIR = os.path.join(os.path.dirname(HERE), "js")

# Globals supplied by the browser, the CDN libraries, or index.html.
KNOWN_GLOBALS = {
    "window", "document", "console", "localStorage", "sessionStorage", "fetch",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "alert",
    "confirm", "prompt", "Promise", "Map", "Set", "Array", "Object", "String",
    "Number", "Boolean", "Date", "Math", "JSON", "RegExp", "Error", "Intl",
    "encodeURIComponent", "decodeURIComponent", "parseInt", "parseFloat",
    "isNaN", "atob", "btoa", "URL", "URLSearchParams", "FormData", "FileReader",
    "Blob", "CustomEvent", "Event", "WebSocket", "Image", "Uint8Array",
    "requestAnimationFrame", "cancelAnimationFrame", "structuredClone",
    "navigator", "location", "history", "screen", "performance", "crypto",
    "AbortController", "TextEncoder", "TextDecoder", "queueMicrotask",
    "getComputedStyle", "HTMLElement", "Node", "NodeList", "DocumentFragment",
    "Symbol", "BigInt", "Proxy", "Reflect", "WeakMap", "WeakSet", "Function",
    "Infinity", "NaN", "undefined", "globalThis", "self", "top", "parent",
    # CDN libraries — see the <script> list at the bottom of index.html
    "Chart", "XLSX", "jspdf", "jsPDF", "QRCode", "html2canvas", "tailwind",
}

KEYWORDS = {
    "if", "for", "while", "switch", "catch", "return", "typeof", "new",
    "delete", "void", "await", "yield", "throw", "function", "do", "else",
    "in", "of", "instanceof", "case", "with", "super", "this", "import",
    "async",  # `async (x) => …` looks like a call to `async`
}

TOP_LEVEL_DECL = re.compile(
    r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:let|const|var)\s+([A-Za-z_$][\w$]*)",
    re.M,
)

ANY_DECL = [
    re.compile(r"\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)"),
    re.compile(r"\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)"),
    re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)"),
    re.compile(r"\b(?:let|const|var)\s*[\{\[]([^}\]]*)[\}\]]"),
    re.compile(r"\bcatch\s*\(\s*([A-Za-z_$][\w$]*)"),
    re.compile(r"\bwindow\.([A-Za-z_$][\w$]*)\s*="),
]

CALL = re.compile(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(")


def strip_literals(src):
    """
    Blank out comment and string contents, preserving length and newlines.

    Without this, Indonesian UI text like "Kode Alat (unik)" and CSS like
    "rgba(0,0,0,.5)" parse as function calls and bury the real signal.
    """
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j == -1 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j == -1 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
            continue
        if src[i] in "\"'`":
            j = jslex._skip_string(src, i)
            for k in range(i + 1, min(j - 1, n)):
                if out[k] != "\n":
                    out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


def js_files():
    found = []
    for dirpath, _, names in os.walk(JS_DIR):
        for n in sorted(names):
            if n.endswith(".js"):
                found.append(os.path.join(dirpath, n))
    return found


def rel(path):
    return os.path.relpath(path, os.path.dirname(HERE)).replace("\\", "/")


def main():
    files = js_files()
    if not files:
        print(f"no .js files under {JS_DIR}")
        return 1

    failures = []

    print(f"1. Bracket balance ({len(files)} files)")
    for path in files:
        problems = jslex.check_balance(path)
        if problems:
            print(f"   FAIL {rel(path)}: {problems[0]}")
            failures.append(f"{rel(path)}: {problems[0]}")
    if not failures:
        print("   all balanced")

    print("\n2. Duplicate top-level declarations")
    owner = {}
    dupes = []
    for path in files:
        text = strip_literals(open(path, encoding="utf-8").read())
        for m in TOP_LEVEL_DECL.finditer(text):
            nm = m.group(1) or m.group(2)
            if nm in owner:
                dupes.append(f"{nm}: {owner[nm]} and {rel(path)}")
            owner[nm] = rel(path)
    if dupes:
        for d in dupes:
            print(f"   FATAL {d}")
        failures.extend(dupes)
    else:
        print(f"   none ({len(owner)} top-level names)")

    print("\n3. Undefined call targets")
    declared = set(KNOWN_GLOBALS)
    sources = {}
    for path in files:
        text = strip_literals(open(path, encoding="utf-8").read())
        sources[path] = text
        for pat in ANY_DECL:
            for m in pat.finditer(text):
                for part in m.group(1).split(","):
                    nm = part.split(":")[-1].split("=")[0].strip().lstrip(".")
                    if re.fullmatch(r"[A-Za-z_$][\w$]*", nm):
                        declared.add(nm)
        for m in re.finditer(r"(?:function\s*\*?\s*[\w$]*\s*|\()\s*([^()]*?)\)\s*(?:=>|\{)", text):
            for part in m.group(1).split(","):
                nm = part.split("=")[0].strip().lstrip("...").strip()
                if re.fullmatch(r"[A-Za-z_$][\w$]*", nm):
                    declared.add(nm)

    missing = {}
    for path, text in sources.items():
        for m in CALL.finditer(text):
            nm = m.group(1)
            if nm in KEYWORDS or nm in declared:
                continue
            missing.setdefault(nm, set()).add(os.path.basename(path))
    if missing:
        # Object method shorthand (`foo(a) { … }`) and regex literals read as
        # calls, so these are reported rather than treated as hard failures.
        print("   review (method shorthand and regex literals are false positives):")
        for nm in sorted(missing):
            print(f"     {nm:<28} {', '.join(sorted(missing[nm]))}")
    else:
        print("   none")

    print("\n" + "=" * 58)
    if failures:
        print("FAILED")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
