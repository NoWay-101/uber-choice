// Shift 2026 — Voice input (Speech Recognition)
(function (S) {
  "use strict";
  let recognition = null,
    isListening = false;

  S.initVoice = function () {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recognition = new SR();
    recognition.lang = "fr-FR";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (e) => {
      const transcript = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join("");
      if (S.activeVoiceInput) {
        S.activeVoiceInput.value = transcript;
        // Hide the placeholder ("Je t'ecoute...") once speech starts
        const overlay = S.activeVoiceInput.closest(".shift-main-input")?.querySelector(".shift-fake-placeholder");
        if (overlay && transcript) overlay.style.display = "none";
      }
      if (e.results[0].isFinal) {
        // Keep the text in the input — user validates with Enter or send button
        stopMic();
      }
    };
    recognition.onend = () => stopMic();
    recognition.onerror = () => stopMic();
  };

  S.toggleMic = function () {
    isListening ? stopMic() : startMic();
  };

  function startMic() {
    if (!recognition || isListening) return;
    isListening = true;
    recognition.start();
    const wrapper = S.activeVoiceInput?.closest(".shift-main-input");
    const btn = wrapper?.querySelector(".shift-mic-btn");
    if (btn) btn.classList.add("listening");
    const overlay = wrapper?.querySelector(".shift-fake-placeholder");
    if (overlay) {
      S.stopPlaceholderRotation();
      if (S.typewriterTimer) {
        clearInterval(S.typewriterTimer);
        S.typewriterTimer = null;
      }
      overlay.innerHTML = "Je t'\u00e9coute...";
    }
  }

  function stopMic() {
    if (!recognition) return;
    isListening = false;
    try {
      recognition.stop();
    } catch (_) {}
    const wrapper = S.activeVoiceInput?.closest(".shift-main-input");
    wrapper?.querySelector(".shift-mic-btn")?.classList.remove("listening");
    const input = S.activeVoiceInput;
    const overlay = wrapper?.querySelector(".shift-fake-placeholder");
    if (overlay) {
      if (input && input.value.trim().length > 0) {
        // Text in input — keep placeholder hidden
        overlay.style.display = "none";
      } else {
        // Empty input — restore placeholder
        overlay.style.display = "";
        var ph = S.shiftActive
          ? (S.activeBottomPlaceholders || S.DEFAULT_BOTTOM_PLACEHOLDERS)
          : S.DEFAULT_PLACEHOLDER;
        S.typewriterPlaceholder(overlay, S.pickRandom(ph));
        S.startPlaceholderRotation(overlay, ph);
      }
    }
    S.activeVoiceInput = null;
  }
})(window.Shift);
