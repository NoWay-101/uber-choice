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
      if (S.activeVoiceInput) S.activeVoiceInput.value = transcript;
      if (e.results[0].isFinal) {
        stopMic();
        if (S.activeVoiceInput) S.activeVoiceInput.value = "";
        S.startFlow(transcript);
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
    const btn = S.inlineBar?.querySelector("#shiftInlineMic");
    if (btn) btn.classList.add("listening");
    const overlay = S.inlineBar?.querySelector("#shiftInlinePlaceholder");
    if (overlay) {
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
    S.inlineBar?.querySelector("#shiftInlineMic")?.classList.remove("listening");
    const overlay = S.inlineBar?.querySelector("#shiftInlinePlaceholder");
    if (overlay) {
      S.typewriterPlaceholder(overlay, S.pickRandom(S.DEFAULT_PLACEHOLDER));
    }
    S.activeVoiceInput = null;
  }
})(window.Shift);
