/** A bot-owned transient status, never a substantive answer or source message. */
export interface DiscordProgressMessage {
  edit(content: string): Promise<void>;
  remove(): Promise<void>;
}

/** Text receipts belong to Discord delivery, never to model reasoning or Evidence. */
export function startDiscordRequestProgress(input: {
  // Ephemeral interaction replies can edit in place without returning a handle.
  send: (update: {
    content: string;
    sequence: number;
  }) => Promise<DiscordProgressMessage | void>;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let receipt: DiscordProgressMessage | void;
  let clearing: Promise<void> | undefined;
  const started = Date.now();
  let pending: Promise<void>;
  async function publish(): Promise<void> {
    const current = sequence++;
    const content =
      current === 0
        ? "Nachricht erhalten. Ich prüfe deine Anfrage."
        : `Ich bin noch dran (${Math.floor((Date.now() - started) / 1000)} Sekunden). Sobald die Bearbeitung beendet ist, melde ich mich mit dem Ergebnis oder dem konkreten Fehler.`;
    try {
      if (receipt) await receipt.edit(content);
      else receipt = await input.send({ sequence: current, content });
    } catch {
      // Do not create more messages after an ambiguous initial send or failed edit.
      // The final response has its own delivery and nonce.
      return;
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
  async function stop(): Promise<void> {
    stopped = true;
    clearTimeout(timer);
    // Drain updates before the final source/audience checks and final delivery.
    await pending;
  }
  async function removeReceipt(): Promise<void> {
    await stop();
    if (!receipt) return;
    try {
      await receipt.remove();
    } catch {
      // If deletion is unavailable, retire the one status without claiming that
      // final delivery succeeded. A Discord outage may prevent this edit too.
      try {
        await receipt.edit("Bearbeitung beendet.");
      } catch {
        /* Best effort. */
      }
    }
  }
  pending = publish();
  return {
    ready: pending,
    stop,
    clear(): Promise<void> {
      clearing ??= removeReceipt();
      return clearing;
    }
  };
}
