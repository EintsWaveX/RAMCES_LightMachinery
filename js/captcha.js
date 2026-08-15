// ═══════════════════════════════════════════════════════════════════════
// Captcha widget — shared by index.html and landing.html
//
// ⚠️ SELF-CONTAINED IIFE, exporting exactly ONE global. That is not a style
// preference, it is the only shape that can be loaded by both pages.
//
// landing.html is a standalone document that declares its OWN `lokasiData`,
// `authToken`, `getJwtPayload`, `showToast` and `getParentLokasiCode` inline.
// Classic scripts share one global lexical scope, so loading any of the js/
// files that also declare those names would be a fatal SyntaxError that blanks
// the QR page — and NEITHER checker would catch it: tools/check_js.py scans
// js/, tools/check_html.py reads index.html, and nothing reads landing.html.
// Same pattern as js/a11y-modal.js, for the same reason.
//
// Everything it needs it takes as arguments or reads off the DOM.
// ═══════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // The markup a mounted widget owns. `currentColor` in the server's SVG means
  // the challenge inherits this element's text colour, so it is legible in both
  // themes without either page passing a palette.
  function widgetHtml(id) {
    return `
      <div class="flex items-center gap-2">
        <div id="${id}-img"
             class="shrink-0 rounded-lg border border-gray-200 dark:border-gray-600
                    bg-gray-50 dark:bg-gray-700/50 px-1 text-gray-700 dark:text-gray-200
                    flex items-center justify-center min-h-[62px] min-w-[190px]"
             aria-hidden="true"></div>
        <button type="button" id="${id}-reload" title="Ganti kode captcha"
                aria-label="Ganti kode captcha"
                class="btn btn-ghost text-xs shrink-0">
          <i class="fas fa-rotate-right"></i>
        </button>
      </div>
      <label for="${id}-answer" class="block text-[11px] font-medium mt-2 mb-1 text-gray-500 dark:text-gray-400">
        Ketik kode di atas
      </label>
      <input type="text" id="${id}-answer" autocomplete="off" inputmode="text"
             spellcheck="false" maxlength="8" placeholder="5 karakter"
             class="w-full p-2.5 bg-gray-50 dark:bg-gray-700 border border-gray-200
                    dark:border-gray-600 rounded-lg text-sm tracking-[0.3em] uppercase
                    outline-none focus:border-kai-blue transition" />`;
  }

  const mounted = new Map(); // containerId -> { token }

  async function load(id, base) {
    const state = mounted.get(id);
    if (!state) return;
    const img = document.getElementById(`${id}-img`);
    const answer = document.getElementById(`${id}-answer`);
    if (img) img.innerHTML = `<span class="text-xs opacity-60">memuat…</span>`;
    try {
      const res = await fetch(`${base}/api/captcha`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      state.token = data.token;
      if (img) img.innerHTML = data.svg;
      if (answer) answer.value = "";
    } catch (e) {
      state.token = "";
      if (img) {
        // A failed challenge must SAY so. Leaving the box blank looks like a
        // slow image and invites the user to submit an empty answer, which then
        // fails for a reason that has nothing to do with what they typed.
        img.innerHTML =
          `<span class="text-xs text-red-500">gagal memuat — klik ⟳</span>`;
      }
    }
  }

  /**
   * Mount the widget into `containerId`.
   *
   * `base` is the API origin prefix — "" on index.html (same origin) and
   * whatever landing.html resolved for its own fetches.
   */
  function mount(containerId, base = "") {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!mounted.has(containerId)) {
      el.innerHTML = widgetHtml(containerId);
      mounted.set(containerId, { token: "" });
      document
        .getElementById(`${containerId}-reload`)
        ?.addEventListener("click", () => load(containerId, base));
    }
    load(containerId, base);
  }

  /** `{captcha_token, captcha_answer}` for the request body, or `{}` if unmounted. */
  function values(containerId) {
    const state = mounted.get(containerId);
    if (!state) return {};
    return {
      captcha_token: state.token || "",
      captcha_answer:
        document.getElementById(`${containerId}-answer`)?.value.trim() || "",
    };
  }

  /**
   * Show or hide the widget's wrapper, mounting it the first time it is shown.
   *
   * Login asks for a captcha PROGRESSIVELY — the server answers
   * `X-Captcha-Required: 1` once a rate-limit bucket trips — so on a normal
   * sign-in this never runs and the form has no captcha in it at all.
   */
  function toggle(wrapperId, containerId, show, base = "") {
    const wrap = document.getElementById(wrapperId);
    if (!wrap) return;
    wrap.classList.toggle("hidden", !show);
    if (show) mount(containerId, base);
  }

  /** A fresh challenge after a failed submit — the old one is spent or wrong. */
  function refresh(containerId, base = "") {
    if (mounted.has(containerId)) load(containerId, base);
  }

  window.RamcesCaptcha = { mount, values, toggle, refresh };
})();
