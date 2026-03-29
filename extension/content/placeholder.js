// Shift 2026 — Typewriter placeholder effect
(function (S) {
  "use strict";

  S.typewriterPlaceholder = function (overlay, text, speed) {
    speed = speed || 30;
    if (S.typewriterTimer) {
      clearInterval(S.typewriterTimer);
      S.typewriterTimer = null;
    }

    const tokens = S.tokenize(text);
    let i = 0;
    overlay.innerHTML = "";
    overlay.style.display = "";
    S.typewriterTimer = setInterval(() => {
      if (i < tokens.length) {
        i++;
        overlay.innerHTML = tokens.slice(0, i).join("");
      } else {
        clearInterval(S.typewriterTimer);
        S.typewriterTimer = null;
      }
    }, speed);
  };

  S.startPlaceholderRotation = function (overlay, placeholders, intervalMs) {
    intervalMs = intervalMs || 8000;
    if (S.rotationTimer) {
      clearInterval(S.rotationTimer);
      S.rotationTimer = null;
    }
    if (placeholders.length <= 1) return;
    S.rotationTimer = setInterval(() => {
      if (overlay.style.display === "none") return;
      S.backspaceAndType(overlay, S.pickRandom(placeholders));
    }, intervalMs);
  };

  S.stopPlaceholderRotation = function () {
    if (S.rotationTimer) {
      clearInterval(S.rotationTimer);
      S.rotationTimer = null;
    }
  };

  S.backspaceAndType = function (overlay, newText, speed) {
    speed = speed || 15;
    if (S.typewriterTimer) {
      clearInterval(S.typewriterTimer);
      S.typewriterTimer = null;
    }

    let visibleLen = overlay.textContent.length;

    S.typewriterTimer = setInterval(() => {
      if (visibleLen > 0) {
        visibleLen--;
        const fullText = overlay.textContent;
        overlay.textContent = fullText.slice(0, visibleLen);
      } else {
        clearInterval(S.typewriterTimer);
        S.typewriterTimer = null;
        S.typewriterPlaceholder(overlay, newText, 30);
      }
    }, speed);
  };
})(window.Shift);
