'use client';
import Image from 'next/image';
import { useState } from 'react';
import { STANDARD_TIP_PRESETS_MINOR } from '@tipme/domain';
import { Button, Lever, Surface } from '@tipme/ui';
import { ExampleQr } from './example-qr';
import { formatNaira } from '@/lib/demo-amount';

type Place = 'counter' | 'stream' | 'post';

const places: { value: Place; label: string }[] = [
  { value: 'counter', label: 'On a counter' },
  { value: 'stream', label: 'On stream' },
  { value: 'post', label: 'In a post' },
];

/** Made-up supporters and notes, labelled as examples on the page. */
const pool: Record<Place, { who: string; note: string }[]> = {
  counter: [
    { who: 'Tolu', note: 'Cleanest fade in Lagos.' },
    { who: 'Bisi', note: 'Thank you for squeezing me in.' },
  ],
  stream: [
    { who: 'nightowl', note: 'That last round was unreal.' },
    { who: 'Kemi', note: 'Staying up was worth it.' },
  ],
  post: [
    { who: 'Seun', note: 'Your Friday edit made my week.' },
    { who: 'Amara', note: 'Keep making these.' },
  ],
};

// The smallest standard amount: the one the demo "tip" sends.
const [TIP] = STANDARD_TIP_PRESETS_MINOR;
const TIP_TEXT = formatNaira(Number(TIP));

interface Slip {
  id: number;
  who: string;
  note: string;
}

/**
 * The individuals hero's demo: where a creator puts their link, and what happens when someone
 * presses Tip. Everything in it is an example (made-up names, notes and a QR that points at
 * the site), and it never talks to the API. The scene and the slip drop stop under reduced motion.
 */
export function WhereYouMeetPeople() {
  const [place, setPlace] = useState<Place>('counter');
  const [slips, setSlips] = useState<Slip[]>([]);
  const [sent, setSent] = useState(0);

  const choose = (next: Place) => {
    setPlace(next);
    setSlips([]);
    setSent(0);
  };
  const tip = () => {
    const choices = pool[place];
    const pick = choices[sent % choices.length];
    if (!pick) return;
    setSlips((current) => [{ id: sent, ...pick }, ...current].slice(0, 2));
    setSent(sent + 1);
  };

  return (
    <Surface material="instrument" className="meet">
      <Lever<Place>
        label="Where you meet people"
        options={places}
        value={place}
        onChange={choose}
      />
      <div className="meet__stage">
        {place === 'counter' && (
          <div
            className="meet__scene meet__scene--counter"
            data-testid="scene-counter"
          >
            <div className="meet__tent">
              <ExampleQr className="meet__qr" />
              <p>Scan to tip Ada</p>
            </div>
            <div className="meet__counter" aria-hidden="true" />
          </div>
        )}
        {place === 'stream' && (
          <div className="meet__scene meet__screen" data-testid="scene-stream">
            <Image
              src="/covers/waveform.webp"
              alt=""
              fill
              sizes="460px"
              className="meet__screen-img"
            />
            <div className="meet__screen-qr">
              <ExampleQr className="meet__qr meet__qr--small" />
            </div>
            <p className="meet__chat">
              <strong>Pinned in chat</strong>
              <br />
              usetipme.xyz/@ada
            </p>
          </div>
        )}
        {place === 'post' && (
          <div
            className="meet__scene meet__scene--post"
            data-testid="scene-post"
          >
            <div className="meet__post">
              <Image
                src="/portraits/ada.webp"
                alt=""
                width={72}
                height={72}
                className="meet__avatar"
              />
              <p className="meet__post-name">Ada Okafor</p>
              <p className="meet__post-bio">
                Video editor. New edits every Friday.
              </p>
              <span className="tm-well meet__link">usetipme.xyz/@ada</span>
            </div>
          </div>
        )}
      </div>
      <div className="meet__bottom">
        <Button
          type="button"
          variant="continue"
          className="meet__tip"
          onClick={tip}
        >
          Tip {TIP_TEXT}
        </Button>
        <div
          className="meet__tray"
          data-testid="example-tray"
          aria-live="polite"
        >
          <span className="meet__tray-label">Example</span>
          {slips.length === 0 && (
            <p className="meet__hint">
              Press Tip. This is where it lands for Ada.
            </p>
          )}
          {slips.map((slip) => (
            <Surface
              key={slip.id}
              material="paper"
              className="meet__slip"
              data-testid="example-slip"
            >
              <strong>{TIP_TEXT}</strong> from {slip.who}
              <br />
              {slip.note}
            </Surface>
          ))}
        </div>
      </div>
      <p className="meet__caption">Examples, not real people.</p>
    </Surface>
  );
}
