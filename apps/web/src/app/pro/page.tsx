import { FEE_POLICY_V1 } from '@tipme/domain';
import { Container, ProBadge } from '@tipme/ui';
import { ProOffer } from '@/components/marketing/pro-offer';
import { formatNaira } from '@/lib/demo-amount';
import { TIPME_SHARE_PERCENT } from '@/lib/fee-share';
import { marketingMetadata } from '@/lib/metadata';

export const metadata = marketingMetadata(
  'Pro',
  'TipMe Pro: grow your appreciation. A page and QR code that look like you, your own tip amounts, up to 8 links, and more on the way.',
  '/pro',
);

type Item = { name: string; detail: string; coming?: true };

// The ProPage board (approved 11 Nov 2026). "Coming" comes off an item only when it ships to
// everyone on Pro.
const MIN_TIP = formatNaira(FEE_POLICY_V1.minTipMinor);
const GROUPS: { title: string; line: string; items: Item[] }[] = [
  {
    title: 'Personalise',
    line: 'Make your page and QR unmistakably yours.',
    items: [
      {
        name: 'Every animated cover, in any colour',
        detail: 'Choose Slow loop or Plays once.',
      },
      {
        name: 'QR studio',
        detail:
          '30 Pro QR designs, and print formats like a counter card, poster or sticker.',
      },
      {
        name: 'Up to 8 links, one featured',
        detail:
          'In your order, with more sites such as your website, Telegram and LinkedIn.',
      },
      {
        name: 'Three username changes',
        detail: 'Your old username keeps leading to your page.',
      },
      {
        name: 'Your own tip amounts',
        detail: `1 to 4 amounts, your minimum (from ${MIN_TIP}) and the one your page starts on.`,
      },
      {
        name: 'Your thank-you',
        detail:
          'Card styles and your signature, and no TipMe invitation at the foot of your page.',
      },
    ],
  },
  {
    title: 'Understand',
    line: 'See how your appreciation is growing.',
    items: [
      {
        name: 'Earnings analytics',
        detail: 'Week, month and year, your average tip, your best day.',
        coming: true,
      },
      {
        name: 'Monthly recap',
        detail:
          'Your month in one card, ready to share. The naira total is off unless you switch it on.',
        coming: true,
      },
      {
        name: 'Repeat supporters',
        detail: 'See who comes back, only if they chose to be recognised.',
        coming: true,
      },
    ],
  },
  {
    title: 'Grow',
    line: 'Find out what brings tips.',
    items: [
      {
        name: 'Campaign links',
        detail:
          'A named link for each place you share, like “New single” or “Saturday gig”, with its own QR code.',
        coming: true,
      },
      {
        name: 'Results per link',
        detail: 'Visits, tips and total for each link. Counts only, never who.',
        coming: true,
      },
    ],
  },
  {
    title: 'Support',
    line: 'Help first, and new things first.',
    items: [
      {
        name: 'Priority support',
        detail: 'Your requests are answered first.',
        coming: true,
      },
      {
        name: 'Early access',
        detail:
          'Try new features before everyone else. Switch it off any time.',
        coming: true,
      },
    ],
  },
];

const FREE_KEEPS = [
  'Receiving tips, with no monthly fee',
  'Your page, username, photo and cover',
  'Your QR code in three looks, ready to print',
  'Withdrawals to your bank',
  'Your full tip history, and a CSV download',
  'Sign-in codes, recovery and security alerts',
  'Up to 3 social links',
  'Three animated covers that play once',
  'Your weekly report, and this week’s totals',
];

const FAQ = [
  {
    q: 'Can I cancel any time?',
    a: 'Yes. Pro stays on until the end of the month you paid for, then your page goes back to Free. No charge after that.',
  },
  {
    q: 'What happens if Pro ends or a payment doesn’t go through?',
    a: 'You get 3 days to pay. After that your page goes back to Free: Pro extras hide, and nothing is deleted. Your designs, links, amounts and settings are kept, and come back if you return to Pro.',
  },
  {
    q: 'Does Pro change what TipMe keeps?',
    a: `No. TipMe keeps ${TIPME_SHARE_PERCENT}% of each tip on both plans, and withdrawals work the same.`,
  },
  {
    q: 'Does the Pro badge mean TipMe checked me?',
    a: 'No. Pro is a paid plan. It shows a page is on Pro, not that TipMe checked who runs it.',
  },
  {
    q: 'What does “Coming” mean?',
    a: 'We’re still building it. Pro members get each one when it’s ready, at no extra cost.',
  },
];

const Tick = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3.5 8.5l3 3 6-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * The page that sells Pro, built to the ProPage board. The price is never in this code: the offer
 * reads the one staff set. Until buying is switched on, the offer says Pro is coming soon to buy.
 */
export default function ProPage() {
  return (
    <main id="main" tabIndex={-1} className="pro-sell marketing-page">
      <Container>
        <section className="pro-sell__hero" aria-labelledby="pro-title">
          <div>
            <p className="pro-sell__kicker">
              TipMe Pro <ProBadge />
            </p>
            <h1 id="pro-title" className="pro-sell__title">
              Grow your appreciation.
            </h1>
            <p className="pro-sell__lead">
              TipMe helps you receive appreciation. Pro helps it grow: a page
              that looks like you, numbers that make sense, and links that show
              where your tips come from.
            </p>
          </div>
          <ProOffer sharePercent={TIPME_SHARE_PERCENT} />
        </section>
      </Container>

      <section className="pro-sell__adds" aria-labelledby="pro-adds-title">
        <Container>
          <h2 id="pro-adds-title" className="pro-sell__h2">
            What Pro adds
          </h2>
          <div className="pro-sell__groups">
            {GROUPS.map((group) => (
              <div key={group.title} className="pro-sell__group">
                <h3>{group.title}</h3>
                <p className="pro-sell__group-line">{group.line}</p>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.name}>
                      <strong>
                        {item.name}
                        {item.coming && (
                          <span className="pro-sell__soon">Coming</span>
                        )}
                      </strong>
                      <span>{item.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <Container>
        <section className="pro-sell__free" aria-labelledby="pro-free-title">
          <h2 id="pro-free-title" className="pro-sell__h2">
            Free stays genuinely useful
          </h2>
          <p className="pro-sell__free-line">
            TipMe — Receive appreciation. These are never behind Pro.
          </p>
          <ul className="pro-sell__keep">
            {FREE_KEEPS.map((line) => (
              <li key={line}>
                <Tick />
                {line}
              </li>
            ))}
          </ul>
        </section>

        <section className="pro-sell__faq" aria-labelledby="pro-faq-title">
          <h2 id="pro-faq-title" className="pro-sell__h2">
            Questions
          </h2>
          <div>
            {FAQ.map(({ q, a }) => (
              <details key={q} className="pro-sell__q">
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
      </Container>
    </main>
  );
}
