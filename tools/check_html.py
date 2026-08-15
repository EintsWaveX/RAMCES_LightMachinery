"""
Structural checks for index.html.

    py -3.10 tools/check_html.py

Sibling to check_js.py. CLAUDE.md states a number of invariants about
index.html in prose, and nothing enforced any of them — so every one was a
convention that held only while somebody remembered it. Each check below is one
of those sentences, made mechanical:

  1. Every `.view-section` is reachable from a nav button. A view with no way
     into it is dead markup that still costs bytes on every load, and the
     failure is invisible: `switchView()` works fine when called from the
     console.
  2. Every modal root has a close control. js/a11y-modal.js closes a dialog on
     Esc by CLICKING that control rather than by hiding the panel, because
     `customConfirm()` resolves its promise from the button handler — a modal
     with no close control leaves every awaiting caller hanging forever.
  3. No duplicate `id`. The whole frontend is `getElementById`, so a duplicate
     silently routes half the code to the wrong element.
  4. Every `<table class="table-stack">` has a `<thead>` with a non-empty
     `<th>`. `stampTableLabels()` copies those captions into `data-label` at
     runtime; with no header row the table opts itself back out and the mobile
     card layout silently reverts to a horizontally scrolling table.
  5. The `js/` <script> tags match LOAD_ORDER in check_js.py, and none of them
     carries defer/async. check_js.py's check 4 — eval-time calls into a later
     file — is only correct if that list is in step with the markup, and
     nothing verified that. `defer` would break the ordering contract outright.

Why HTMLParser and not tools/jslex.py: jslex is a JavaScript tokenizer and the
questions here are about element nesting and attributes. `html.parser` is
stdlib, dependency-free (Node is not available on this machine, so every
HTML linter built on it is out), and lenient in the same way a browser is.
"""

import os
import sys
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

INDEX = os.path.join(ROOT, "index.html")

# Views with no nav button ON PURPOSE: both are drill-downs reached from a card
# or a row, not destinations. `view-edit` opens from an asset card;
# `view-history-detail` opens from Pantau Riwayat and returns via #close-hist-btn.
NAV_EXEMPT = {"view-edit", "view-history-detail"}

# The dashboard matrix is deliberately excluded from .table-stack (its columns
# ARE the data), so it never reaches check 4. Any table listed here is asserted
# NOT to carry the class, so the exclusion cannot be undone by accident.
STACK_EXEMPT_IDS = set()

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}


class El:
    __slots__ = ("tag", "attrs", "children", "parent", "line", "text")

    def __init__(self, tag, attrs, line, parent=None):
        self.tag = tag
        self.attrs = attrs
        self.children = []
        self.parent = parent
        self.line = line
        self.text = ""

    def attr(self, name):
        return self.attrs.get(name)

    def classes(self):
        return set((self.attrs.get("class") or "").split())

    def walk(self):
        yield self
        for c in self.children:
            yield from c.walk()

    def find(self, tag):
        return [e for e in self.walk() if e.tag == tag]


class Tree(HTMLParser):
    """A forgiving element tree. Unclosed tags are tolerated, as in a browser."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = El("#document", {}, 0)
        self.stack = [self.root]
        self.ids = []          # [(id, line)] in document order, duplicates kept

    def handle_starttag(self, tag, attrs):
        d = {}
        for k, v in attrs:
            # A repeated attribute on one element keeps the first, like a browser.
            d.setdefault(k, v if v is not None else "")
        el = El(tag, d, self.getpos()[0], self.stack[-1])
        self.stack[-1].children.append(el)
        if "id" in d and d["id"]:
            self.ids.append((d["id"], el.line))
        if tag not in VOID:
            self.stack.append(el)

    def handle_startendtag(self, tag, attrs):
        d = {}
        for k, v in attrs:
            d.setdefault(k, v if v is not None else "")
        el = El(tag, d, self.getpos()[0], self.stack[-1])
        self.stack[-1].children.append(el)
        if "id" in d and d["id"]:
            self.ids.append((d["id"], el.line))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return
        # Stray close tag: ignore, as a browser does.

    def handle_data(self, data):
        if self.stack:
            self.stack[-1].text += data


def is_modal_root(el):
    """
    Mirror of isModalRoot() in js/a11y-modal.js — keep the two in step.

    A modal root is the full-screen BACKDROP, not the white panel inside it.
    Matching the `-modal` id suffix keeps the loading overlay and the mobile
    sidebar scrim (also `fixed inset-0`) out of the dialog logic.

    This is also the trap for a naive `[id$="-modal"]` selector: most ids ending
    in `-modal` in this file are the close BUTTONS (`close-<id>-modal`) and two
    opener buttons, not roots at all.
    """
    if el.tag != "div":
        return False
    cls = el.classes()
    if "modal-backdrop" in cls:
        return True
    return bool(el.attr("id")) and el.attr("id").endswith("-modal") and \
        "fixed" in cls and "inset-0" in cls


def close_control(root):
    """The id/marker that would close this dialog, or None.

    Accepts every form the file actually uses. a11y-modal.js looks for
    `#close-<id>`, then `[data-modal-close]`, then `button[id$="-cancel"]`; the
    markup also uses `<id>-close` and `<prefix>-close`, so all are allowed here.
    """
    rid = root.attr("id") or ""
    prefix = rid[: -len("-modal")] if rid.endswith("-modal") else rid
    wanted = {f"close-{rid}", f"{rid}-close", f"close-{prefix}", f"{prefix}-close"}
    for el in root.walk():
        if el is root:
            continue
        if el.attr("data-modal-close") is not None:
            return "[data-modal-close]"
        eid = el.attr("id") or ""
        if eid in wanted:
            return f"#{eid}"
        if el.tag == "button" and eid.endswith("-cancel"):
            return f"#{eid}"
    return None


def load_order():
    """LOAD_ORDER from check_js.py, so the two cannot drift."""
    import check_js
    return list(check_js.LOAD_ORDER)


def main():
    if not os.path.isfile(INDEX):
        print(f"not found: {INDEX}")
        return 1

    with open(INDEX, encoding="utf-8") as fh:
        src = fh.read()

    tree = Tree()
    tree.feed(src)
    doc = tree.root
    failures = []

    # ── 1. every view has a nav button ────────────────────────────
    views = [
        e for e in doc.walk()
        if "view-section" in e.classes() and e.attr("id")
    ]
    targets = {
        e.attr("data-view") for e in doc.walk() if e.attr("data-view")
    }
    print(f"1. Views reachable from a nav button ({len(views)} views, {len(targets)} nav targets)")
    orphans = []
    for v in views:
        vid = v.attr("id")
        if vid in NAV_EXEMPT:
            continue
        if not vid.startswith("view-") or vid[len("view-"):] not in targets:
            orphans.append(f"{vid} (line {v.line}) has no button with data-view=\"{vid[5:]}\"")
    if orphans:
        for o in orphans:
            print(f"   FAIL {o}")
        failures.extend(orphans)
    else:
        print(f"   all reachable ({len(NAV_EXEMPT)} exempt drill-downs: {', '.join(sorted(NAV_EXEMPT))})")

    # nav buttons pointing at a view that does not exist
    view_ids = {v.attr("id") for v in views}
    dangling = sorted(t for t in targets if f"view-{t}" not in view_ids)
    if dangling:
        for t in dangling:
            print(f"   FAIL data-view=\"{t}\" but there is no #view-{t}")
        failures.extend(f"dangling data-view={t}" for t in dangling)

    # ── 2. every modal root has a close control ───────────────────
    roots = [e for e in doc.walk() if is_modal_root(e)]
    print(f"\n2. Modal close controls ({len(roots)} modal roots)")
    bad = []
    for r in roots:
        if close_control(r) is None:
            bad.append(f"{r.attr('id') or '(no id)'} (line {r.line}) has no close control")
    if bad:
        for b in bad:
            print(f"   FAIL {b}")
        failures.extend(bad)
    else:
        print("   all have one")
    # How many ids merely END in -modal but are not roots — the selector trap.
    lookalikes = [
        i for i, _ in tree.ids
        if i.endswith("-modal") and i not in {r.attr("id") for r in roots}
    ]
    print(f"   ({len(lookalikes)} other ids end in -modal and are NOT roots — buttons)")

    # ── 3. no duplicate ids ───────────────────────────────────────
    print(f"\n3. Duplicate ids ({len(tree.ids)} ids)")
    seen, dupes = {}, []
    for i, line in tree.ids:
        if i in seen:
            dupes.append(f"{i}: lines {seen[i]} and {line}")
        else:
            seen[i] = line
    if dupes:
        for d in dupes:
            print(f"   FATAL {d}")
        failures.extend(dupes)
    else:
        print(f"   none ({len(seen)} unique)")

    # ── 4. .table-stack needs a <thead> with a non-empty <th> ─────
    stacks = [e for e in doc.walk() if e.tag == "table" and "table-stack" in e.classes()]
    print(f"\n4. Stacked tables have header captions ({len(stacks)} tables)")
    headless = []
    for t in stacks:
        theads = t.find("thead")
        caption = any(
            th.text.strip() or th.find("i")
            for thead in theads
            for th in thead.find("th")
        )
        if not theads:
            headless.append(
                f"line {t.line}: .table-stack with no <thead> — "
                f"stampTableLabels() has nothing to copy, so it opts out of the "
                f"mobile card layout at runtime"
            )
        elif not caption:
            headless.append(f"line {t.line}: .table-stack <thead> has no non-empty <th>")
    if headless:
        for h in headless:
            print(f"   FAIL {h}")
        failures.extend(headless)
    else:
        print("   all have a header row with captions")

    # ── 5. script order matches check_js.py, and nothing defers ───
    scripts = [
        e for e in doc.walk()
        if e.tag == "script" and (e.attr("src") or "").startswith("js/")
    ]
    print(f"\n5. js/ script tags ({len(scripts)})")
    order = [e.attr("src")[len("js/"):] for e in scripts]
    try:
        expected = load_order()
    except Exception as exc:
        expected = None
        print(f"   skip (could not import check_js: {exc})")
    if expected is not None:
        if order != expected:
            print("   FAIL <script> order does not match LOAD_ORDER in check_js.py")
            for i in range(max(len(order), len(expected))):
                a = order[i] if i < len(order) else "—"
                b = expected[i] if i < len(expected) else "—"
                if a != b:
                    print(f"        {i}: index.html={a}   check_js={b}")
            failures.append("script order != check_js.LOAD_ORDER")
        else:
            print(f"   order matches check_js.LOAD_ORDER ({len(order)} files)")
    deferred = [
        e.attr("src") for e in scripts
        if e.attr("defer") is not None or e.attr("async") is not None
    ]
    if deferred:
        for d in deferred:
            print(f"   FAIL {d} carries defer/async — the files share one global "
                  f"scope and must evaluate in order")
        failures.extend(f"{d} deferred" for d in deferred)
    else:
        print("   none deferred")

    print("\n" + "=" * 58)
    if failures:
        print(f"FAILED ({len(failures)})")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
