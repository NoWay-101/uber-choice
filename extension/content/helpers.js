// Shift 2026 — Utility functions
(function (S) {
  "use strict";

  S.esc = function (s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  };

  S.scrollTop = function () {
    const area = S.shiftRoot?.querySelector("#shiftScrollArea");
    if (area) area.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  S.tokenize = function (html) {
    const tokens = [];
    let i = 0;
    while (i < html.length) {
      if (html[i] === "<") {
        const end = html.indexOf(">", i);
        tokens.push(html.slice(i, end + 1));
        i = end + 1;
      } else {
        tokens.push(html[i]);
        i++;
      }
    }
    return tokens;
  };

  let lastPlaceholder = null;

  S.pickRandom = function (arr) {
    if (arr.length <= 1) return arr[0];
    let pick;
    do {
      pick = arr[Math.floor(Math.random() * arr.length)];
    } while (pick === lastPlaceholder);
    lastPlaceholder = pick;
    return pick;
  };
})(window.Shift);
