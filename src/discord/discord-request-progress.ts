/** Text receipts belong to Discord delivery, never to model reasoning or Evidence. */
export function startDiscordRequestProgress(input: {
  send: (update: { content: string; sequence: number }) => Promise<void>;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  const started = Date.now();
  let pending: Promise<void>;
  async function publish(): Promise<void> {
    const current = sequence++;
    try {
      await input.send({
        sequence: current,
        content:
          current === 0
            ? "Nachricht erhalten. Ich prüfe deine Anfrage."
            : `Ich bin noch dran (${Math.floor((Date.now() - started) / 1000)} Sekunden). Sobald die Bearbeitung beendet ist, melde ich mich mit dem Ergebnis oder dem konkreten Fehler.`
      });
    } catch {
      // A failed receipt must not discard the actual request or retry an
      // ambiguously delivered message. The final response has its own nonce.
    }
    if (!stopped) {
      timer = setTimeout(
        () => {
          pending = publish();
        },
        current === 0 ? 15_000 : 30_000
      );
      timer.unref();
    }
  }
  pending = publish();
  return {
    ready: pending,
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      // Drain any in-flight update before sending the final response, so a
      // late status message cannot make a completed request look unfinished.
      await pending;
    }
  };
}
