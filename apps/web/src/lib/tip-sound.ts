/**
 * The soft sound for a new paid tip (owner's ruling, 3 Nov 2026): only in a hidden tab, only after
 * the page has had a click or a key press (browsers block page audio before that), and only while
 * "Sound for new tips" is on. It never fails loudly: a refused play() is ignored. Reduced motion
 * has no bearing on it; the switch does.
 */
export interface TipSound {
  /** The page has had a pointerdown or keydown. */
  readonly armed: boolean;
  play(o: { enabled: boolean; isPaidTip: boolean }): void;
}

interface AudioLike {
  volume: number;
  play(): Promise<void> | void;
}

export function createTipSound(o: {
  src: '/sounds/new-tip.wav';
  volume: 0.35;
  Audio: new (src: string) => AudioLike;
  document: Pick<Document, 'visibilityState' | 'addEventListener'>;
}): TipSound {
  let armed = false;
  let audio: AudioLike | null = null;
  const arm = () => {
    armed = true;
  };
  o.document.addEventListener('pointerdown', arm, { once: true });
  o.document.addEventListener('keydown', arm, { once: true });
  return {
    get armed() {
      return armed;
    },
    play({ enabled, isPaidTip }) {
      if (!enabled || !isPaidTip || !armed) return;
      // A visible tab already shows the toast.
      if (o.document.visibilityState !== 'hidden') return;
      try {
        audio ??= new o.Audio(o.src);
        audio.volume = o.volume;
        void Promise.resolve(audio.play()).catch(() => undefined);
      } catch {
        // No audio here: silent, as the switch promises at worst.
      }
    },
  };
}
