'use client';
import { useId, useState, type FormEvent } from 'react';
import type { MyMembership } from '@tipme/contracts';
import { Button, InputField, StateLine } from '@tipme/ui';
import {
  leaveMembership,
  updateMembership,
  workChanged,
} from '@/lib/business/members-api';

/**
 * One workplace on the Work page (business PR B3): how the person shows there ("Shown as", their
 * photo or not), and Leave, which asks first and is instant.
 */
export function WhereYouWorkCard({ membership }: { membership: MyMembership }) {
  const id = useId();
  const [shownName, setShownName] = useState(membership.shownName);
  const [showPhoto, setShowPhoto] = useState(membership.showPhoto);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; nameError?: string }
  >({ kind: 'idle' });
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveFailed, setLeaveFailed] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = shownName.trim();
    if (trimmed.length === 0 || Array.from(trimmed).length > 30) {
      setState({ kind: 'error', nameError: '1 to 30 characters.' });
      return;
    }
    setState({ kind: 'saving' });
    const result = await updateMembership(membership.memberId, {
      shownName: trimmed,
      showPhoto,
    });
    if (result.ok) {
      setShownName(result.data.shownName);
      setState({ kind: 'saved' });
    } else
      setState(
        result.fields?.includes('shownName')
          ? { kind: 'error', nameError: '1 to 30 characters.' }
          : { kind: 'error' },
      );
  };

  const leave = async () => {
    setLeaving(true);
    setLeaveFailed(false);
    const result = await leaveMembership(membership.memberId);
    setLeaving(false);
    if (result.ok || result.status === 404) workChanged();
    else setLeaveFailed(true);
  };

  const location = membership.location.name;
  return (
    <div className="work-where">
      <form className="work-where__form" onSubmit={save} noValidate>
        <InputField
          id={`${id}-name`}
          label="Shown as"
          hint={`The name customers see at ${location}.`}
          value={shownName}
          autoComplete="off"
          error={state.kind === 'error' ? state.nameError : undefined}
          onChange={(event) => {
            setShownName(event.target.value);
            setState({ kind: 'idle' });
          }}
        />
        <label className="tip-remember" htmlFor={`${id}-photo`}>
          <input
            id={`${id}-photo`}
            type="checkbox"
            role="switch"
            checked={showPhoto}
            onChange={(event) => {
              setShowPhoto(event.target.checked);
              setState({ kind: 'idle' });
            }}
          />
          <span>Show my photo</span>
        </label>
        <div className="work-where__actions">
          <Button type="submit" disabled={state.kind === 'saving'}>
            Save
          </Button>
        </div>
        {state.kind === 'saved' && <StateLine tone="status">Saved.</StateLine>}
        {state.kind === 'error' && !state.nameError && (
          <StateLine tone="error">
            We couldn’t save that. Please try again.
          </StateLine>
        )}
      </form>
      <div className="work-where__leave">
        {confirming ? (
          <div
            role="group"
            aria-labelledby={`${id}-leave-title`}
            className="work-where__confirm"
          >
            <p id={`${id}-leave-title`}>
              You’ll stop showing at {location} straight away. Your tips and
              balance stay yours.
            </p>
            <div className="work-where__actions">
              <Button disabled={leaving} onClick={() => void leave()}>
                Yes, leave {location}
              </Button>
              <Button
                variant="secondary"
                disabled={leaving}
                onClick={() => setConfirming(false)}
              >
                Stay
              </Button>
            </div>
            {leaveFailed && (
              <StateLine tone="error">
                We couldn’t do that just now. Please try again.
              </StateLine>
            )}
          </div>
        ) : (
          <Button variant="quiet" onClick={() => setConfirming(true)}>
            Leave {location}
          </Button>
        )}
      </div>
    </div>
  );
}
