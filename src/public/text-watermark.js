/* Text Watermark tool — embed / validate / clean invisible Unicode watermarks.
   Everything runs client-side; no text is sent anywhere. */
(function () {
  "use strict";

  /* ---------- codec ---------- */

  var BIT0 = "‌"; // zero-width non-joiner
  var BIT1 = "‍"; // zero-width joiner
  var MARK = "⁠"; // word joiner — payload delimiter

  function encodePayload(message) {
    var bytes = new TextEncoder().encode(message);
    var out = MARK;
    for (var i = 0; i < bytes.length; i++) {
      for (var b = 7; b >= 0; b--) {
        out += (bytes[i] >> b) & 1 ? BIT1 : BIT0;
      }
    }
    return out + MARK;
  }

  function embedWatermark(text, message) {
    var payload = encodePayload(message);
    // Insert after the first word so the payload survives leading/trailing trims.
    var idx = text.search(/\s/);
    if (idx === -1) return text + payload;
    return text.slice(0, idx) + payload + text.slice(idx);
  }

  function extractWatermark(text) {
    var m = text.match(new RegExp(MARK + "([" + BIT0 + BIT1 + "]+)" + MARK));
    if (!m || m[1].length % 8 !== 0) return null;
    var bits = m[1];
    var bytes = new Uint8Array(bits.length / 8);
    for (var i = 0; i < bytes.length; i++) {
      var v = 0;
      for (var b = 0; b < 8; b++) {
        v = (v << 1) | (bits[i * 8 + b] === BIT1 ? 1 : 0);
      }
      bytes[i] = v;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  /* ---------- invisible character inventory ---------- */

  // Zero-width / format / bidi / tag characters — removed entirely by Clean.
  var INVISIBLE_RE =
    /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁤⁦-⁩ㅤ︀-️﻿ﾠ\u{E0000}-\u{E007F}]/gu;

  // Exotic spaces — visible whitespace often used to evade filters. Clean
  // normalizes each to a plain space (U+0020) rather than deleting it, so words
  // stay separated. Covers U+00A0, U+1680, U+2000-200A, U+202F, U+205F, U+3000,
  // and the braille blank U+2800.
  var EXOTIC_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u2800]/g;

  var CHAR_NAMES = {
    0x00ad: "soft hyphen",
    0x034f: "combining grapheme joiner",
    0x061c: "Arabic letter mark",
    0x200b: "zero-width space",
    0x200c: "zero-width non-joiner",
    0x200d: "zero-width joiner",
    0x200e: "left-to-right mark",
    0x200f: "right-to-left mark",
    0x2060: "word joiner",
    0x2061: "function application",
    0x2062: "invisible times",
    0x2063: "invisible separator",
    0x2064: "invisible plus",
    0xfeff: "byte order mark / ZWNBSP",
    0x00a0: "no-break space",
    0x1680: "ogham space mark",
    0x202f: "narrow no-break space",
    0x205f: "medium mathematical space",
    0x3000: "ideographic space",
    0x2800: "braille pattern blank",
  };

  function charName(cp) {
    if (CHAR_NAMES[cp]) return CHAR_NAMES[cp];
    if (cp >= 0xfe00 && cp <= 0xfe0f) return "variation selector";
    if (cp >= 0x202a && cp <= 0x202e) return "bidi control";
    if (cp >= 0x2066 && cp <= 0x2069) return "bidi isolate";
    if (cp >= 0x180b && cp <= 0x180f) return "Mongolian selector/separator";
    if (cp >= 0x2000 && cp <= 0x200a) return "exotic space";
    if (cp >= 0xe0000 && cp <= 0xe007f) return "Unicode tag character";
    return "hidden character";
  }

  function inventory(text) {
    var counts = new Map();
    var total = 0;
    function scan(re) {
      for (var m of text.matchAll(re)) {
        var cp = m[0].codePointAt(0);
        counts.set(cp, (counts.get(cp) || 0) + 1);
        total++;
      }
    }
    scan(INVISIBLE_RE);
    scan(EXOTIC_SPACE_RE);
    return { total: total, counts: counts };
  }

  // Normalize exotic spaces to a plain space, then strip zero-width/format chars.
  function cleanText(text) {
    return text.replace(EXOTIC_SPACE_RE, " ").replace(INVISIBLE_RE, "");
  }

  /* ---------- UI ---------- */

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function hex(cp) {
    return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
  }

  /* tabs */
  var tabs = [
    { tab: $("tab-check"), pane: $("pane-check") },
    { tab: $("tab-embed"), pane: $("pane-embed") },
  ];
  tabs.forEach(function (entry) {
    entry.tab.addEventListener("click", function () {
      tabs.forEach(function (other) {
        var active = other === entry;
        other.tab.setAttribute("aria-selected", active ? "true" : "false");
        other.pane.hidden = !active;
      });
    });
  });

  /* check */
  $("check-run").addEventListener("click", function () {
    var text = $("check-input").value;
    var report = $("check-report");
    report.hidden = false;
    if (!text) {
      report.innerHTML = "<p>Paste some text first.</p>";
      return;
    }
    var inv = inventory(text);
    var html = "";
    if (inv.total === 0) {
      html += "<p><strong>Clean.</strong> No hidden or unusual characters found in " +
        text.length + " characters.</p>";
    } else {
      html += "<p><strong>" + inv.total + " hidden or unusual character" +
        (inv.total === 1 ? "" : "s") + " found</strong> in " + text.length +
        " characters:</p><ul>";
      inv.counts.forEach(function (count, cp) {
        html += "<li>" + hex(cp) + " " + esc(charName(cp)) + " × " + count + "</li>";
      });
      html += "</ul>";
      var mark = extractWatermark(text);
      html += mark !== null
        ? "<p>Decoded watermark: <strong>" + esc(mark) + "</strong></p>"
        : "<p>No decodable watermark payload (characters may be a different scheme, or plain noise).</p>";
    }
    report.innerHTML = html;
  });

  /* clean */
  $("clean-run").addEventListener("click", function () {
    var text = $("check-input").value;
    if (!text) {
      $("check-report").hidden = false;
      $("check-report").innerHTML = "<p>Paste some text first.</p>";
      return;
    }
    var removed = inventory(text).total;
    $("clean-output").value = cleanText(text);
    $("clean-output-wrap").hidden = false;
    $("check-report").hidden = false;
    $("check-report").innerHTML =
      "<p>Cleaned <strong>" + removed + "</strong> hidden or unusual character" +
      (removed === 1 ? "" : "s") +
      " (invisible characters removed; exotic spaces normalized).</p>";
  });

  /* embed */
  $("embed-run").addEventListener("click", function () {
    var text = $("embed-input").value;
    var message = $("embed-message").value;
    var report = $("embed-report");
    if (!text || !message) {
      report.hidden = false;
      report.innerHTML = "<p>Both the text and the watermark message are required.</p>";
      return;
    }
    var marked = embedWatermark(cleanText(text), message);
    $("embed-output").value = marked;
    $("embed-output-wrap").hidden = false;
    report.hidden = false;
    report.innerHTML =
      "<p>Embedded a <strong>" + (marked.length - cleanText(text).length) +
      "</strong>-character invisible payload. Verify it in the Check tab.</p>";
  });

  /* copy buttons */
  function wireCopy(buttonId, sourceId) {
    var button = $(buttonId);
    button.addEventListener("click", function () {
      navigator.clipboard.writeText($(sourceId).value).then(function () {
        var original = button.textContent;
        button.textContent = "Copied";
        setTimeout(function () {
          button.textContent = original;
        }, 1500);
      });
    });
  }
  wireCopy("clean-copy", "clean-output");
  wireCopy("embed-copy", "embed-output");
})();
