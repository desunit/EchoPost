// Admin-only enhancements. Loaded on /admin pages (CSP script-src 'self', so no
// inline handlers). Event-delegated so it works for media added after load.
(function () {
  "use strict";

  // Insert an uploaded image's Markdown at the cursor in the Body textarea.
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".insert-md");
    if (!btn) return;
    e.preventDefault();
    var ta = document.querySelector('textarea[name="markdown_body"]');
    if (!ta) return;
    var md = btn.getAttribute("data-md") || "";
    var start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    var end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    var before = ta.value.slice(0, start);
    var lead = before.length && before[before.length - 1] !== "\n" ? "\n" : "";
    var snippet = lead + md + "\n";
    ta.value = before + snippet + ta.value.slice(end);
    var pos = start + snippet.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
  });
})();
