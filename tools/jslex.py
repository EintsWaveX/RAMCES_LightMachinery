"""
A small JavaScript-aware tokenizer, good enough to find TOP-LEVEL statement
boundaries in app.js.

There is no Node.js on this machine, so a real parser is not available. This
tracks strings, template literals (including nested `${}` expressions),
comments and regex literals well enough to know when a brace is structural, and
that is all the split needs.
"""


def scan(src):
    """Yield (index, char, depth) for every structural character."""
    i, n = 0, len(src)
    depth = 0
    prev_significant = ""
    while i < n:
        c = src[i]

        # line comment
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j == -1 else j
            continue
        # block comment
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        # strings and templates
        if c in "\"'`":
            i = _skip_string(src, i)
            prev_significant = c
            continue
        # regex literal: a '/' is a regex only where a value is expected
        if c == "/" and _regex_allowed(prev_significant):
            j = _skip_regex(src, i)
            if j is not None:
                i = j
                prev_significant = "/"
                continue

        if c in "{([":
            depth += 1
            yield i, c, depth
        elif c in "})]":
            yield i, c, depth
            depth -= 1

        if not c.isspace():
            prev_significant = c
        i += 1


def _skip_string(src, i):
    q = src[i]
    n = len(src)
    j = i + 1
    while j < n:
        ch = src[j]
        if ch == "\\":
            j += 2
            continue
        if q == "`" and src.startswith("${", j):
            k, d = j + 2, 1
            while k < n and d:
                if src[k] == "\\":
                    k += 2
                    continue
                if src[k] in "\"'`":
                    k = _skip_string(src, k)
                    continue
                if src[k] == "{":
                    d += 1
                elif src[k] == "}":
                    d -= 1
                k += 1
            j = k
            continue
        if ch == q:
            return j + 1
        j += 1
    return n


def _regex_allowed(prev):
    return prev == "" or prev in "(,=:[!&|?{};+-*%~^<>"


def _skip_regex(src, i):
    n = len(src)
    j = i + 1
    in_class = False
    while j < n:
        ch = src[j]
        if ch == "\\":
            j += 2
            continue
        if ch == "\n":
            return None  # not a regex after all
        if ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        elif ch == "/" and not in_class:
            j += 1
            while j < n and src[j].isalpha():
                j += 1
            return j
        j += 1
    return None


def check_balance(path):
    """Return a list of problems, empty if the file is structurally sound."""
    src = open(path, encoding="utf-8").read()
    stack = []
    pairs = {"}": "{", ")": "(", "]": "["}
    problems = []
    for idx, ch, _ in scan(src):
        line = src.count("\n", 0, idx) + 1
        if ch in "{([":
            stack.append((ch, line))
        else:
            if not stack:
                problems.append(f"unmatched {ch} at line {line}")
                break
            op, ol = stack.pop()
            if op != pairs[ch]:
                problems.append(
                    f"mismatch: {op} opened line {ol}, closed by {ch} at line {line}"
                )
                break
    for op, ol in stack[-5:]:
        problems.append(f"unclosed {op} opened at line {ol}")
    return problems


def top_level_statements(path):
    """
    Split a file into top-level statements.

    A statement ends at a `;` or `}` that sits at depth 0. Leading blank lines
    and comment blocks attach to the statement that follows them, so a function
    never gets separated from its doc comment.
    """
    src = open(path, encoding="utf-8").read()
    ends = []
    for idx, ch, depth in scan(src):
        if ch == "}" and depth == 1:
            ends.append(idx)

    # Also treat depth-0 semicolons as terminators (top-level let/const).
    i, n = 0, len(src)
    depth = 0
    struct = {idx: (ch, d) for idx, ch, d in scan(src)}
    while i < n:
        if i in struct:
            ch, d = struct[i]
            depth = d if ch in "{([" else d - 1
        elif src[i] == ";" and depth == 0:
            ends.append(i)
        elif src[i] in "\"'`":
            i = _skip_string(src, i)
            continue
        elif src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j == -1 else j
            continue
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        i += 1

    ends = sorted(set(ends))
    chunks = []
    start = 0
    for e in ends:
        # extend to end of line
        nl = src.find("\n", e)
        stop = n if nl == -1 else nl + 1
        chunks.append((start, stop))
        start = stop
    if start < n:
        chunks.append((start, n))
    return src, chunks
