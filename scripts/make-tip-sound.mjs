#!/usr/bin/env node
// Writes apps/web/public/sounds/new-tip.wav: the soft sound for a new paid tip in a background tab
// (owner's ruling, 3 Nov 2026). Authored here, so it is ours and licence-free; the test checks the
// committed file is exactly what this makes.
//
//   node scripts/make-tip-sound.mjs
import { writeFileSync } from 'node:fs';

export const TIP_SOUND_RATE = 22_050;
const NOTE_S = 0.25;
const FADE_S = 0.02;
// About -19.5 dBFS at the peak: quiet, under the -18 dBFS ceiling.
const AMPLITUDE = 0.105;
// E5 then A5: a rising fourth, gentle rather than an alarm.
const NOTES = [659.25, 880];

/** 22.05 kHz mono, 0.5 s: two soft sine notes with 20 ms fades in and out of each. */
export function tipSoundSamples() {
  const perNote = Math.round(TIP_SOUND_RATE * NOTE_S);
  const fade = Math.round(TIP_SOUND_RATE * FADE_S);
  const samples = new Int16Array(perNote * NOTES.length);
  NOTES.forEach((frequency, n) => {
    for (let i = 0; i < perNote; i += 1) {
      // A raised-cosine envelope: exactly 0 at both ends of each note, so there is no click.
      const edge = Math.min(i, perNote - 1 - i);
      const envelope =
        edge >= fade ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade);
      const value =
        AMPLITUDE *
        envelope *
        Math.sin((2 * Math.PI * frequency * i) / TIP_SOUND_RATE);
      samples[n * perNote + i] = Math.round(value * 32767);
    }
  });
  return samples;
}

/** A 16-bit PCM mono WAV file. */
export function wav(samples, rate) {
  const data = samples.length * 2;
  const file = Buffer.alloc(44 + data);
  file.write('RIFF', 0, 'ascii');
  file.writeUInt32LE(36 + data, 4);
  file.write('WAVE', 8, 'ascii');
  file.write('fmt ', 12, 'ascii');
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20); // PCM
  file.writeUInt16LE(1, 22); // mono
  file.writeUInt32LE(rate, 24);
  file.writeUInt32LE(rate * 2, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write('data', 36, 'ascii');
  file.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i += 1)
    file.writeInt16LE(samples[i], 44 + i * 2);
  return file;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL('../apps/web/public/sounds/new-tip.wav', import.meta.url);
  writeFileSync(out, wav(tipSoundSamples(), TIP_SOUND_RATE));
  console.log(`Wrote ${out.pathname}`);
}
