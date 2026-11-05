'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  EmptySlip,
  EmptyWell,
  InputField,
  ResultKey,
  Slip,
  StandingWarning,
  StateLine,
  Steps,
  useKeyResult,
} from '@tipme/ui';

const amountError =
  'Enter an amount of NGN 2,000 or more, like 2,000 or 2,500.50.';
const withdrawalSteps = ['Requested', 'Sent to our payment partner', 'Paid'];

/**
 * The states patterns (StatesConcepts, FeedbackMoments) with the boards' real words. Specimens
 * only: nothing here is sent anywhere. The keys and the field need state, so this is a client
 * island like the lever.
 */
export function StatesSpecimen() {
  return (
    <section
      data-testid="states-specimen"
      aria-labelledby="ds-states"
      className="states-specimen"
    >
      <h2 id="ds-states">States</h2>
      <p>
        The slip explains; the key tells you. No tinted boxes, and a reassuring
        line only where the code proves it.
      </p>
      <div className="states-specimen__grid">
        <div className="states-specimen__column">
          <p className="states-specimen__label">Slips</p>
          <Slip
            tone="error"
            stamp={'Not\nsent'}
            title="Not sent yet"
            safe="You haven’t paid anything."
            actions={<Button variant="continue">Try again</Button>}
          >
            We couldn’t reach TipMe. Check your connection and try again.
          </Slip>
          <Slip
            tone="error"
            stamp="Failed"
            title="Failed"
            safe="Back in your balance: ₦15,000"
          >
            3 Nov 2026. It didn’t go through, so the money is back in your
            balance.
          </Slip>
          <Slip tone="unsure" stamp={'Check\nfirst'} title="Not confirmed">
            We couldn’t confirm your withdrawal. Check your dashboard before
            trying again.
          </Slip>
          <Slip
            tone="waiting"
            dense
            stamp={'On\nhold'}
            title="Waiting for a second person"
          >
            Nothing has changed yet. Someone else who holds this permission has
            to approve it, and they’ve been told.
          </Slip>
          <Slip
            tone="done"
            dense
            stamp={'Done\nalone'}
            title="Done, without a second person"
          >
            … Nobody else can approve this right now, so it ran straight away.
            The log and the alert say you acted alone.
          </Slip>
          <Slip tone="error" title="We couldn’t load your dashboard">
            Please reload the page.
          </Slip>
          <Slip title="TipMe has paused your page">
            Visitors see “This page isn’t available right now” and nobody can
            start a new tip. Tips already on their way still reach you.
          </Slip>
        </div>
        <div className="states-specimen__column">
          <p className="states-specimen__label">Standing warning</p>
          <StandingWarning title="Withdrawals are OFF for everyone">
            New withdrawals are refused and queued ones wait, reserved.
          </StandingWarning>
          <p className="states-specimen__label">Keys</p>
          <SaveKeySpecimen />
          <p className="states-specimen__label">Field</p>
          <AmountFieldSpecimen />
          <p className="states-specimen__label">Steps</p>
          <Steps labels={withdrawalSteps} filled={1} label="Withdrawal" />
          <Steps
            labels={withdrawalSteps}
            filled={0}
            failed
            label="Failed withdrawal"
          />
          <p className="states-specimen__label">Empty</p>
          <EmptySlip
            title="No tips here yet."
            caption="Your first note lands here"
            headingLevel={3}
            action={<Button variant="secondary">Copy your link</Button>}
          />
          <EmptyWell title="Nothing is waiting" headingLevel={3} />
        </div>
      </div>
    </section>
  );
}

/**
 * The Feedback section's two key results, held still: a generic, non-financial save that worked
 * and one that didn't.
 */
export function FeedbackKeysSpecimen() {
  return (
    <div className="specimen-row">
      <ResultKey result={{ kind: 'done', label: 'Preferences saved' }}>
        Save preferences
      </ResultKey>
      <ResultKey
        result={{
          kind: 'failed',
          label: 'Could not save',
          retryLabel: 'Try again',
          onRetry() {},
        }}
      >
        Save preferences
      </ResultKey>
    </div>
  );
}

/** How long the specimen's pretend save takes, so the in-flight key can be seen and tested. */
const SAVE_MS = 400;

/**
 * "Save notifications" on a result key. The toggle makes the next save fail once; the save is
 * in flight for a moment, with the key busy but focusable.
 */
function SaveKeySpecimen() {
  const [failNext, setFailNext] = useState(false);
  const [line, setLine] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  // Try again runs the latest save, so it reads the toggle as it is now.
  const key = useKeyResult({ onRetry: () => save() });
  function save() {
    const fail = failNext;
    if (fail) setFailNext(false);
    setLine('');
    key.start();
    timer.current = setTimeout(() => {
      if (fail) {
        setLine('We couldn’t save that. Please try again.');
        key.failed({
          label: 'Not saved',
          detail: '· notifications',
          retryLabel: 'Try again',
        });
      } else key.done('Saved.');
    }, SAVE_MS);
  }
  return (
    <div className="states-specimen__keys">
      <div className="specimen-row">
        <ResultKey
          variant="continue"
          result={key.result}
          pending={key.pending}
          onClick={save}
          data-testid="states-save-key"
        >
          Save notifications
        </ResultKey>
        <Button
          variant="secondary"
          aria-pressed={failNext}
          onClick={() => setFailNext((value) => !value)}
        >
          Make the next save fail
        </Button>
      </div>
      <StateLine tone="error">{line}</StateLine>
      <StateLine tone="status" visuallyHidden>
        {key.result?.kind === 'done' ? key.result.label : ''}
      </StateLine>
    </div>
  );
}

/** The Other amount with its flag; Check makes it invalid, and a repeat Check keeps it so. */
function AmountFieldSpecimen() {
  const [error, setError] = useState('');
  return (
    <div className="states-specimen__field">
      <InputField
        id="ds-states-amount"
        label="Other amount (NGN 2,000 or more)"
        inputMode="decimal"
        defaultValue="1,500"
        // As on the tip form: typing clears the error, and the field must keep focus and value.
        onChange={() => setError('')}
        error={error || undefined}
        flag="below 2,000"
      />
      <Button variant="secondary" onClick={() => setError(amountError)}>
        Check
      </Button>
    </div>
  );
}
