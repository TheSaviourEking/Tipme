import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { tipSoundSamples, wav, TIP_SOUND_RATE } from './make-tip-sound.mjs';

const committed = () =>
  readFileSync(
    new URL('../apps/web/public/sounds/new-tip.wav', import.meta.url),
  );

test('the committed sound matches the generator byte for byte', () => {
  assert.ok(wav(tipSoundSamples(), TIP_SOUND_RATE).equals(committed()));
});

test('it is mono, under one second, and peaks at or below -18 dBFS', () => {
  const file = committed();
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.toString('ascii', 8, 12), 'WAVE');
  assert.equal(file.readUInt16LE(20), 1, 'PCM');
  assert.equal(file.readUInt16LE(22), 1, 'mono');
  const rate = file.readUInt32LE(24);
  assert.equal(file.readUInt16LE(34), 16, '16-bit');
  const samples = tipSoundSamples();
  assert.ok(samples.length / rate < 1, `${samples.length / rate} s`);
  const peak = Math.max(...Array.from(samples, (s) => Math.abs(s)));
  const dbfs = 20 * Math.log10(peak / 32768);
  assert.ok(dbfs <= -18, `peak ${dbfs.toFixed(1)} dBFS`);
  assert.ok(file.length < 30_000, `${file.length} bytes`);
});

test('it starts and ends at silence (no click)', () => {
  const samples = tipSoundSamples();
  assert.equal(samples[0], 0);
  assert.equal(samples[samples.length - 1], 0);
  // The fades are gentle: the first and last 5 ms stay very quiet.
  const edge = Math.round(TIP_SOUND_RATE * 0.005);
  for (const s of [...samples.slice(0, edge), ...samples.slice(-edge)])
    assert.ok(Math.abs(s) < 600, `${s}`);
});
