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
  4. TOP-LEVEL code calling a function that a LATER file declares. Function
     declarations hoist within their own file, but the files are evaluated in
     the order index.html lists them — so `debounce()` called at core.js eval
     time, when it lives in search.js, throws and kills the rest of core.js and
     with it the whole page. Check 3 cannot see this: the identifier does
     exist, just not yet.

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


# The order index.html loads these in. Anything not listed is checked last,
# which is the safe assumption. Keep in step with the <script> tags — the
# comment block at the bottom of index.html is the source of truth.
LOAD_ORDER = [
    "core.js",
    "a11y-modal.js",
    "api.js",
    "search.js",
    "shell.js",
    "views/dashboard.js",
    "views/aset.js",
    "views/riwayat.js",
    "views/kdak.js",
    "views/afkir.js",
    "views/masterdata.js",
    "views/sort-modals.js",
    "views/laporan.js",
    "views/repair-dashboard.js",
    "views/spektek.js",
    "views/inventaris.js",
]


def load_index(relpath):
    """Position of a file in the evaluation order; unknown files sort last."""
    key = relpath.split("js/", 1)[-1]
    return LOAD_ORDER.index(key) if key in LOAD_ORDER else len(LOAD_ORDER)


def _matching_brace(text, open_at):
    """Index of the `}` that closes the `{` at open_at, or -1."""
    depth = 0
    for i in range(open_at, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


# A function body opens at one of these. `function foo(...) {`, `function (…) {`,
# `(a, b) => {`, `a => {`, and object-method shorthand `foo(...) {`.
_BODY_OPEN = re.compile(
    r"(?:\bfunction\b[^(){}]*\([^()]*\)\s*\{)"      # function decl / expression
    r"|(?:\)\s*=>\s*\{)"                              # (a, b) => {
    r"|(?:\b[\w$]+\s*=>\s*\{)"                        # a => {
)

_IIFE_AFTER = re.compile(r"^\s*\)?\s*\(")


def _defer_bodies(text):
    """
    Blank out every function body that does NOT run at evaluation time.

    A body is kept when it is immediately invoked — `(function(){...})()` and
    `(() => {...})()` both execute as the file is parsed, so a call inside one
    is every bit as early as a call at the top level. That is exactly where the
    bug this check exists for lived: an IIFE in core.js reaching for debounce()
    from search.js.

    Everything else — an event handler, a callback, a named function nobody has
    called yet — runs later, by which time every file has been evaluated.
    """
    out = list(text)
    i = 0
    while i < len(text):
        m = _BODY_OPEN.search(text, i)
        if not m:
            break
        open_at = text.index("{", m.end() - 1)
        close_at = _matching_brace(text, open_at)
        if close_at < 0:
            break
        # Immediately invoked? Look at what follows the closing brace.
        if _IIFE_AFTER.match(text[close_at + 1 : close_at + 8]):
            i = open_at + 1          # descend into it: this body IS eval-time
            continue
        for k in range(open_at, close_at + 1):
            if out[k] != "\n":
                out[k] = " "
        i = close_at + 1
    return "".join(out)


def top_level_calls(text):
    """
    Function names called from code that runs at EVAL time.

    Everything reachable while the <script> tag is still executing: the file's
    own top level, plus the body of any immediately-invoked wrapper. Calls
    inside a deferred body are excluded, because by the time those run every
    file in the list has been evaluated.
    """
    stripped = _defer_bodies(text)
    return [(m.group(1), m.start()) for m in CALL.finditer(stripped)]


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

    print("\n4. Eval-time calls into a later file")
    # Where each top-level name is declared, and how early that file runs.
    decl_file = {}
    for path in files:
        text = strip_literals(open(path, encoding="utf-8").read())
        for m in TOP_LEVEL_DECL.finditer(text):
            nm = m.group(1) or m.group(2)
            decl_file.setdefault(nm, rel(path))

    early = []
    for path in files:
        here = load_index(rel(path))
        text = strip_literals(open(path, encoding="utf-8").read())
        for nm, _pos in top_level_calls(text):
            owner_path = decl_file.get(nm)
            if not owner_path:
                continue
            if owner_path == rel(path):
                continue
            if load_index(owner_path) > here:
                early.append(
                    f"{rel(path)} calls {nm}() at eval time, but it is declared "
                    f"in {owner_path} which loads later"
                )
    if early:
        for e in sorted(set(early)):
            print(f"   FATAL {e}")
        failures.extend(early)
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
