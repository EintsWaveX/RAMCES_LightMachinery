// ════════════════════════════════════════════════════════════════════
// MODAL ACCESSIBILITY — role/aria, Esc, focus trap, focus return
// ════════════════════════════════════════════════════════════════════
//
// Every modal in this app is markup that already exists in index.html and is
// shown by removing a `hidden` class. There are ~33 of them and none carried
// `role="dialog"`, none trapped focus, Esc did nothing, and focus never left
// the element that opened the panel — so a keyboard or screen-reader user
// could open a dialog and then tab straight out of it into the page behind.
//
// This file fixes all of that generically rather than by editing 33 markup
// blocks, for two reasons: the attributes are entirely derivable from the
// markup that is already there, and a behavioural fix applied by hand 33 times
// is 33 chances to miss one. Modals rendered later from template strings are
// picked up by the same observer, which hand-edited markup could not cover.
//
// Everything lives in an IIFE: this file adds no top-level identifier beyond
// the two `window.*` exports, so it cannot collide with another file in the
// shared global scope (see tools/check_js.py).

(function setupModalA11y() {
  "use strict";

  // A modal root is the full-screen backdrop, not the white panel inside it.
  // Matching on the `-modal` id suffix keeps the loading overlay and the mobile
  // sidebar scrim — which are also `fixed inset-0` — out of the dialog logic.
  function isModalRoot(el) {
    if (!el || el.nodeType !== 1 || el.tagName !== "DIV") return false;
    if (el.classList.contains("modal-backdrop")) return true;
    return (
      /-modal$/.test(el.id || "") &&
      el.classList.contains("fixed") &&
      el.classList.contains("inset-0")
    );
  }

  const FOCUSABLE = [
    "a[href]",
    "area[href]",
    "button:not([disabled])",
    'input:not([disabled]):not([type="hidden"])',
    "select:not([disabled])",
    "textarea:not([disabled])",
    "iframe",
    "[contenteditable]",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  // Only things the user can actually reach: a modal keeps its markup in the
  // DOM while closed, and `display:none` subtrees still match a CSS selector.
  function focusablesIn(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll(FOCUSABLE),
      (el) =>
        !el.hasAttribute("hidden") &&
        (el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    );
  }

  function isOpen(root) {
    return !root.classList.contains("hidden");
  }

  // ── Announce the dialog to assistive tech ────────────────────────────────
  // Label priority: an existing heading (the panel title the sighted user
  // reads), then any aria-label already authored, then the id turned into
  // words — never nothing, because an unlabelled dialog is announced only as
  // "dialog" and gives no clue what just opened.
  function enhance(root) {
    if (root.dataset.a11yReady) return;
    root.dataset.a11yReady = "1";

    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");

    if (!root.hasAttribute("aria-label") && !root.hasAttribute("aria-labelledby")) {
      const heading = root.querySelector("h1, h2, h3, h4");
      if (heading) {
        if (!heading.id) heading.id = (root.id || "modal") + "-a11y-title";
        root.setAttribute("aria-labelledby", heading.id);
      } else {
        root.setAttribute(
          "aria-label",
          (root.id || "dialog").replace(/-modal$/, "").replace(/[-_]/g, " ").trim(),
        );
      }
    }

    // The panel is the focus target of last resort, for a dialog whose only
    // content is text.
    const panel = root.firstElementChild;
    if (panel && !panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");

    // Icon-only close buttons announce as just "button" with no name. They all
    // follow one of two id conventions, so name them here rather than adding
    // 28 aria-labels to the markup — and so any modal added later is covered.
    root.querySelectorAll('[id^="close-"], [id$="-close"], [data-modal-close]')
      .forEach(nameCloseButton);

    state.set(root, { open: isOpen(root), returnTo: null });
  }

  function nameCloseButton(btn) {
    if (btn.hasAttribute("aria-label") || btn.getAttribute("title")) return;
    if ((btn.textContent || "").trim()) return; // already has a visible name
    btn.setAttribute("aria-label", "Tutup");
  }

  const state = new WeakMap();
  const stack = []; // innermost dialog last; this app does stack confirm-modal over others

  function scan() {
    document.querySelectorAll('div[id$="-modal"], div.modal-backdrop').forEach((el) => {
      if (isModalRoot(el)) enhance(el);
    });
  }

  function onOpened(root) {
    const st = state.get(root) || {};
    st.open = true;
    // Where focus came from, so it can be handed back on close. Falls back to
    // body rather than null so the restore path never throws.
    st.returnTo =
      document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    state.set(root, st);

    const idx = stack.indexOf(root);
    if (idx !== -1) stack.splice(idx, 1);
    stack.push(root);

    // Wait a frame: the opener often fills the panel in immediately after
    // un-hiding it, and focusing before that lands on the wrong control.
    requestAnimationFrame(() => {
      if (!isOpen(root)) return;
      const items = focusablesIn(root);
      // Prefer a real field over the decorative × in the corner, so a form
      // dialog opens ready to type.
      const target =
        items.find((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) ||
        items[0] ||
        root.firstElementChild ||
        root;
      try {
        target.focus({ preventScroll: true });
      } catch (_) {
        /* detached between frames */
      }
    });
  }

  function onClosed(root) {
    const st = state.get(root) || {};
    st.open = false;
    const idx = stack.indexOf(root);
    if (idx !== -1) stack.splice(idx, 1);

    const back = st.returnTo;
    st.returnTo = null;
    state.set(root, st);

    // Two cases. If a dialog is still open underneath — customConfirm stacked
    // over a form is the common one — focus belongs back inside THAT dialog,
    // not on the opener behind everything. Hiding the panel that held focus
    // otherwise drops the user on <body>, which fires no focusin, so the trap
    // below never gets a chance to correct it.
    const outer = stack[stack.length - 1];
    let target = null;
    if (outer) {
      target =
        back && document.contains(back) && outer.contains(back)
          ? back
          : focusablesIn(outer)[0] || outer.firstElementChild || outer;
    } else if (back && document.contains(back)) {
      target = back;
    }
    if (target) {
      try {
        target.focus({ preventScroll: true });
      } catch (_) {
        /* opener was re-rendered away */
      }
    }
  }

  function syncState(root) {
    const st = state.get(root);
    if (!st) return;
    const open = isOpen(root);
    if (open === st.open) return;
    if (open) onOpened(root);
    else onClosed(root);
  }

  // ── Esc ──────────────────────────────────────────────────────────────────
  // Route through the dialog's OWN close control wherever one exists, never by
  // slapping `hidden` back on. customConfirm() resolves its promise from the
  // button handler, so hiding the panel directly would leave every awaiting
  // caller hanging forever — the modal would vanish and the app would sit
  // there waiting for an answer that can no longer arrive.
  function requestClose(root) {
    // Preferred close controls, most specific first. `close-<id>` is the
    // convention, but several dialogs name their button after the panel rather
    // than the backdrop (#close-master-edit for #master-edit-modal), so also
    // accept a close-* button that lives inside this dialog.
    const explicit =
      document.getElementById("close-" + root.id) ||
      root.querySelector("[data-modal-close]") ||
      root.querySelector('[id^="close-"], [id$="-close"]') ||
      Array.prototype.find.call(root.querySelectorAll("button"), (b) =>
        /-cancel$/.test(b.id || ""),
      );

    if (explicit) {
      explicit.click();
      // The control may be inert — customConfirm() nulls its own handlers once
      // resolved, and some close buttons only reset a form. Never leave the
      // user trapped in a dialog Esc appeared to dismiss: if the click did not
      // actually close it, hide it ourselves.
      if (isOpen(root)) root.classList.add("hidden");
      return;
    }
    root.classList.add("hidden");
  }

  document.addEventListener(
    "keydown",
    (e) => {
      const top = stack[stack.length - 1];
      if (!top || !isOpen(top)) return;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        requestClose(top);
        return;
      }

      if (e.key !== "Tab") return;

      const items = focusablesIn(top);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !top.contains(active);

      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    },
    true,
  );

  // Focus can also enter the background without Tab — a stray .focus() call, or
  // a click on the page behind a backdrop that does not cover everything.
  document.addEventListener("focusin", (e) => {
    const top = stack[stack.length - 1];
    if (!top || !isOpen(top) || top.contains(e.target)) return;
    const items = focusablesIn(top);
    (items[0] || top.firstElementChild || top).focus({ preventScroll: true });
  });

  // ── Keep up with the DOM ─────────────────────────────────────────────────
  // `class` because open/close is a class toggle; childList because several
  // views build their modals from template strings after this file has run.
  const observer = new MutationObserver((records) => {
    let added = false;
    for (const rec of records) {
      if (rec.type === "attributes") {
        if (isModalRoot(rec.target)) {
          enhance(rec.target);
          syncState(rec.target);
        }
      } else if (rec.addedNodes.length) {
        added = true;
      }
    }
    if (added) scan();
  });

  function start() {
    scan();
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // Exposed so a view can close its own dialog through the same path Esc uses,
  // and so the count is checkable from the console.
  window.closeModalA11y = requestClose;
  window.a11yModalCount = () =>
    document.querySelectorAll('div[data-a11y-ready="1"]').length;
})();
