'use client';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Surface } from '@tipme/ui';

// The Home hero's example cards (docs/design/DECISION-LOG.md, 3 Nov 2026). They are a picture,
// so the whole stack is aria-hidden and holds nothing focusable: the cards answer a mouse (a
// fine pointer that can hover, the same test the CSS motion uses) at any width. A touch screen gets
// the plain card. Nothing here fetches or navigates.
const FINE_POINTER = '(hover: hover) and (pointer: fine)';
const canPlay = () => window.matchMedia(FINE_POINTER).matches;

type Slot = 'left' | 'centre' | 'right';
const SLOTS: Slot[] = ['left', 'centre', 'right'];
const ADA = 'Ada';

/**
 * The cards as a carousel: their names from left to right, and whether the centre one is turned
 * over. Only the centre card turns over; any other card, clicked, turns the carousel to the centre.
 */
type Carousel = { order: string[]; turned: boolean };

const CarouselContext = createContext<{
  carousel: Carousel;
  /** The centre card turns over or back; a side card comes to the centre, face up. */
  choose(name: string): void;
  /** Turns the centre card back, if it is still this one. */
  turnBack(name: string): void;
}>({
  carousel: { order: ['Tobi', ADA, 'Zainab'], turned: false },
  choose: () => {},
  turnBack: () => {},
});

/** Where a card sits in the carousel, and whether it shows its note. */
function useCarouselCard(name: string) {
  const { carousel, choose, turnBack } = useContext(CarouselContext);
  const slot = SLOTS[carousel.order.indexOf(name)] ?? 'centre';
  return {
    slot,
    centred: slot === 'centre',
    flipped: slot === 'centre' && carousel.turned,
    choose: () => choose(name),
    turnBack: () => turnBack(name),
  };
}

/** The stack of example cards, Tobi to the left of Ada and Zainab to her right. */
export function DemoStack({ children }: { children: ReactNode }) {
  const [carousel, setCarousel] = useState<Carousel>({
    order: ['Tobi', ADA, 'Zainab'],
    turned: false,
  });
  const choose = (name: string) =>
    setCarousel(({ order, turned }) => {
      const at = order.indexOf(name);
      if (at === 1) return { order, turned: !turned };
      // Turn the ring one place, so the chosen card moves into the middle.
      const turnedRing =
        at === 0
          ? [order[2], order[0], order[1]]
          : [order[1], order[2], order[0]];
      return { order: turnedRing as string[], turned: false };
    });
  const turnBack = (name: string) =>
    setCarousel((was) =>
      was.order[1] === name ? { ...was, turned: false } : was,
    );
  return (
    <CarouselContext.Provider value={{ carousel, choose, turnBack }}>
      <div className="home-demo__stack" aria-hidden="true">
        {children}
      </div>
    </CarouselContext.Provider>
  );
}

/** How long Ada's thank-you stays before the card settles back. */
const THANKS_MS = 4500;

function Shell({
  className,
  slot,
  flipped,
  onClick,
  front,
  back,
  children,
}: {
  className: string;
  slot: Slot;
  flipped: boolean;
  onClick(): void;
  front: ReactNode;
  back: ReactNode;
  children?: ReactNode;
}) {
  return (
    // Pointer only on purpose: the stack is decorative and hidden from assistive technology.
    <div
      className={`home-flip ${className}`}
      data-slot={slot}
      data-flipped={flipped ? 'true' : 'false'}
      // Set once the browser has this component, so a click is never lost to hydration.
      ref={(node) => node?.setAttribute('data-ready', 'true')}
      onClick={onClick}
    >
      <div className="home-flip__inner">
        <Surface
          material="instrument"
          className="home-flip__face home-flip__front"
        >
          {front}
        </Surface>
        <Surface material="paper" className="home-flip__face home-flip__back">
          {back}
        </Surface>
      </div>
      {children}
    </div>
  );
}

function Slip({ note, from }: { note: ReactNode; from: string }) {
  return (
    <div className="home-slip">
      <span className="home-slip__label">Example</span>
      <p className="home-slip__note">{note}</p>
      <p className="home-slip__from">{from}</p>
    </div>
  );
}

/** An example person: click to turn the card over to a thank-you note, click again to turn back. */
export function PersonCard({
  className,
  front,
  note,
  name,
}: {
  className: string;
  front: ReactNode;
  note: string;
  name: string;
}) {
  const { slot, flipped, choose } = useCarouselCard(name);
  return (
    <Shell
      className={className}
      slot={slot}
      flipped={flipped}
      onClick={() => canPlay() && choose()}
      front={front}
      back={<Slip note={note} from={name} />}
    />
  );
}

const BURST = Array.from({ length: 9 }, (_, i) => ({
  dx: Math.round(Math.sin(i * 2.4) * 70),
  dy: -(90 + ((i * 37) % 70)),
  delay: (i * 55) % 330,
  scale: 0.7 + ((i * 13) % 6) / 10,
}));

/**
 * Ada's card: keys that can be chosen, and a Tip that sends up hearts, turns the card to a thank
 * you for the chosen amount and, a few seconds later, settles back. It pays nothing.
 */
export function AdaCard({
  cover,
  avatar,
  amounts,
  initial,
  note,
}: {
  cover: ReactNode;
  avatar: ReactNode;
  amounts: string[];
  initial: number;
  note: string;
}) {
  const [chosen, setChosen] = useState(initial);
  const { slot, centred, flipped, choose, turnBack } = useCarouselCard(ADA);
  const [thanks, setThanks] = useState<string | null>(null);
  const [burst, setBurst] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const settle = () => {
    clearTimeout(timer.current);
    // Only if Ada is still in the centre; the carousel may have turned since.
    turnBack();
    // The thank-you stays on the back until the card has turned away from it.
    timer.current = setTimeout(() => setThanks(null), 700);
  };
  const tip = () => {
    if (!canPlay()) return;
    clearTimeout(timer.current);
    setThanks(amounts[chosen] ?? null);
    setBurst((count) => count + 1);
    if (!flipped) choose();
    timer.current = setTimeout(settle, THANKS_MS);
  };
  const label = amounts[chosen] ?? '';

  return (
    <Shell
      className="home-demo__main"
      slot={slot}
      flipped={flipped}
      onClick={() => {
        if (!canPlay()) return;
        if (flipped) settle();
        else {
          setThanks(null);
          choose();
        }
      }}
      front={
        <>
          <div className="home-demo__cover">{cover}</div>
          <div className="home-demo__body">
            <span className="home-demo__avatar">{avatar}</span>
            <p className="home-demo__name">Ada Okafor</p>
            <p className="home-demo__role">Content creator/Video editor</p>
            <div className="home-keys">
              {amounts.map((amount, index) => (
                <span
                  key={amount}
                  className="home-key"
                  data-selected={index === chosen ? 'true' : undefined}
                  onClick={(event) => {
                    // To one side, the click goes on to the card and brings Ada to the centre.
                    if (!canPlay() || !centred) return;
                    event.stopPropagation();
                    setChosen(index);
                  }}
                >
                  {amount}
                </span>
              ))}
            </div>
            <span
              className="home-demo__tip"
              onClick={(event) => {
                if (!canPlay() || !centred) return;
                event.stopPropagation();
                tip();
              }}
            >
              Tip {label}
            </span>
          </div>
        </>
      }
      back={
        <Slip
          note={thanks ? `Thank you for the ${thanks}!` : note}
          from="Ada"
        />
      }
    >
      {burst > 0 && (
        <span className="home-burst" key={burst}>
          {BURST.map((heart, index) => (
            <svg
              key={index}
              viewBox="0 0 24 24"
              className="home-burst__heart"
              style={
                {
                  '--dx': `${heart.dx}px`,
                  '--dy': `${heart.dy}px`,
                  '--delay': `${heart.delay}ms`,
                  '--s': heart.scale,
                } as React.CSSProperties
              }
            >
              <path d="M12 21s-7.5-4.6-9.6-9.3C1 8.4 3 5 6.4 5c2.2 0 4 1.2 5.6 3.4C13.6 6.2 15.4 5 17.6 5 21 5 23 8.4 21.6 11.7 19.5 16.4 12 21 12 21z" />
            </svg>
          ))}
        </span>
      )}
    </Shell>
  );
}
