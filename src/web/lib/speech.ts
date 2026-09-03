/** Voice in (Web Speech API) and voice out (speechSynthesis). Progressive: silently unavailable where unsupported. */
type RecognitionCtor = new () => {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> & { [i: number]: { isFinal: boolean } } }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start: () => void;
  stop: () => void;
};

export function speechSupported(): boolean {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return !!(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

export function listen(onText: (text: string, final: boolean) => void, onEnd: () => void): () => void {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) {
    onEnd();
    return () => {};
  }
  const rec = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    let text = "";
    let final = false;
    for (let i = 0; i < e.results.length; i++) {
      text += e.results[i]![0]!.transcript;
      if (e.results[i]!.isFinal) final = true;
    }
    onText(text, final);
  };
  rec.onend = onEnd;
  rec.onerror = onEnd;
  rec.start();
  return () => rec.stop();
}

export function speak(text: string): void {
  if (!("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[*_#`]/g, ""));
  u.rate = 1.02;
  u.pitch = 1;
  const voices = window.speechSynthesis.getVoices();
  const pick = voices.find((v) => /en/i.test(v.lang) && /Samantha|Daniel|Google UK English Female|Karen|Moira/i.test(v.name)) ?? voices.find((v) => /en/i.test(v.lang));
  if (pick) u.voice = pick;
  window.speechSynthesis.speak(u);
}
export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
