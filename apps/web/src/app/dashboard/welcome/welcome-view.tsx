'use client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { MyProfile, ProfilePatch } from '@tipme/contracts';
import {
  ActionLink,
  Button,
  InputField,
  Notice,
  Surface,
  TextareaField,
} from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { Arrow } from '@/components/brand';
import { apiFetch } from '@/lib/session-client';
import { useSiteHost } from '@/lib/site-host';

type Step = 'hello' | 'about' | 'bio' | 'live' | 'done';
const setupSteps = ['about', 'bio', 'live'] as const;

const initialsFor = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** The person's page as supporters will meet it, updating while they type. */
function PagePreview({
  handle,
  name,
  role,
  bio,
}: {
  handle: string;
  name: string;
  role: string;
  bio: string;
}) {
  return (
    <figure className="welcome-preview" aria-label="Preview of your page">
      <div className="welcome-preview__portrait" aria-hidden="true">
        <span>{initialsFor(name || handle)}</span>
      </div>
      <Surface material="raised" className="welcome-preview__card">
        <p className="welcome-preview__name">{name || handle}</p>
        <p className="welcome-preview__handle">@{handle}</p>
        {role && <p className="welcome-preview__role">{role}</p>}
        <p className="welcome-preview__bio">
          {bio || 'A line about you will appear here.'}
        </p>
      </Surface>
      <figcaption>Your page, as supporters will see it</figcaption>
    </figure>
  );
}

/**
 * The onboarding event after a handle is claimed: a welcome, three skippable steps that save as
 * they go, and the moment the page goes live. Nothing here is required to use TipMe.
 */
export function WelcomeView() {
  const id = useId();
  const host = useSiteHost();
  const { profile, setProfile } = useRecipient();
  const [step, setStep] = useState<Step>('hello');
  const [name, setName] = useState(
    profile.displayName === profile.handle ? '' : profile.displayName,
  );
  const [role, setRole] = useState(profile.role ?? '');
  const [bio, setBio] = useState(profile.bio ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  // Each step change moves focus to its heading so screen readers hear where they are.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const go = (next: Step) => {
    setError('');
    setStep(next);
  };

  const save = async (patch: ProfilePatch, next: Step) => {
    setBusy(true);
    setError('');
    const result = await apiFetch<MyProfile>('/v1/me/profile', {
      method: 'PATCH',
      body: patch,
    });
    setBusy(false);
    if (!result.ok) {
      setError(
        result.fields?.includes('displayName')
          ? 'Add the name people know you by.'
          : 'We couldn’t save that. Check your connection and try again.',
      );
      return;
    }
    setProfile(result.data);
    go(next);
  };

  const saveAbout = (event: FormEvent) => {
    event.preventDefault();
    void save(
      { displayName: name.trim() || profile.handle, role: role.trim() || null },
      'bio',
    );
  };

  const saveBio = (event: FormEvent) => {
    event.preventDefault();
    void save({ bio: bio.trim() || null }, 'live');
  };

  const goLive = async () => {
    setBusy(true);
    setError('');
    const result = await apiFetch<MyProfile>('/v1/me/page/state', {
      method: 'PUT',
      body: { state: 'live' },
    });
    setBusy(false);
    if (!result.ok) {
      setError(
        'We couldn’t put your page online. You can try again, or do it later in Settings.',
      );
      return;
    }
    setProfile(result.data);
    go('done');
  };

  const link = host ? `${host}/@${profile.handle}` : `/@${profile.handle}`;
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/@${profile.handle}`,
      );
      setCopied('Link copied.');
    } catch {
      setCopied(
        'Copy is unavailable here. You can copy it from the address above.',
      );
    }
  };

  const firstName = (
    profile.displayName === profile.handle ? '' : profile.displayName
  ).split(/\s+/)[0];
  const position = setupSteps.indexOf(step as (typeof setupSteps)[number]);
  const live = profile.pageState === 'live';

  if (step === 'hello')
    return (
      <section
        className="welcome welcome--hello"
        aria-labelledby={`${id}-title`}
      >
        <p className="welcome-pill">You’re in</p>
        <h1
          id={`${id}-title`}
          className="welcome-title"
          ref={heading}
          tabIndex={-1}
        >
          Welcome to TipMe.
        </h1>
        <p className="welcome-lede">
          <strong>@{profile.handle}</strong> is yours now. Let’s make your page
          feel like you. It takes about a minute, and you can skip anything.
        </p>
        <Surface material="raised" className="welcome-card welcome-plan">
          <ol>
            <li className="is-done">Claim your handle</li>
            <li>Tell people your name and what you do</li>
            <li>Add a line about you</li>
            <li>Put your page online and share it</li>
          </ol>
          <Button className="welcome-continue" onClick={() => go('about')}>
            Let’s set up your page <Arrow />
          </Button>
          <Link className="welcome-later" href="/dashboard">
            I’ll do this later
          </Link>
        </Surface>
      </section>
    );

  if (step === 'done')
    return (
      <section
        className="welcome welcome--done"
        aria-labelledby={`${id}-title`}
      >
        <div className="welcome-moment" aria-hidden="true">
          <span>✓</span>
        </div>
        <h1
          id={`${id}-title`}
          className="welcome-title"
          ref={heading}
          tabIndex={-1}
        >
          {live
            ? `You’re all set${firstName ? `, ${firstName}` : ''}.`
            : `You’re set up${firstName ? `, ${firstName}` : ''}.`}
        </h1>
        <p className="welcome-lede">
          {live
            ? 'Your page is live. Anyone with your link or QR code can thank you now.'
            : 'Your page is ready but not online yet. You can put it online from Settings whenever you like.'}
        </p>
        <Surface material="raised" className="welcome-card welcome-share">
          <p className="welcome-share__label">Your link</p>
          <p className="welcome-share__link">{link}</p>
          <div className="welcome-share__actions">
            <Button variant="secondary" onClick={() => void copyLink()}>
              Copy link
            </Button>
            <ActionLink variant="secondary" href="/dashboard/qr">
              Get my QR code
            </ActionLink>
            <ActionLink variant="secondary" href={`/@${profile.handle}`}>
              See my page
            </ActionLink>
          </div>
          <p role="status" className="tm-hint">
            {copied}
          </p>
          <ActionLink className="welcome-continue" href="/dashboard">
            Go to my dashboard <Arrow />
          </ActionLink>
        </Surface>
      </section>
    );

  return (
    <section className="welcome welcome--setup" aria-labelledby={`${id}-title`}>
      <div className="welcome-step">
        <ol className="auth-progress" aria-label="Setting up your page">
          {['Name', 'About you', 'Go live'].map((label, index) => (
            <li
              key={label}
              className={
                index < position
                  ? 'is-done'
                  : index === position
                    ? 'is-current'
                    : ''
              }
              aria-current={index === position ? 'step' : undefined}
            >
              {label}
            </li>
          ))}
        </ol>

        {step === 'about' && (
          <form onSubmit={saveAbout} noValidate className="welcome-form">
            <h1
              id={`${id}-title`}
              className="welcome-heading"
              ref={heading}
              tabIndex={-1}
            >
              What should people call you?
            </h1>
            <InputField
              id={`${id}-name`}
              label="Your name"
              maxLength={60}
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint="The name supporters know you by."
            />
            <InputField
              id={`${id}-role`}
              label="What you do"
              maxLength={60}
              value={role}
              onChange={(event) => setRole(event.target.value)}
              hint="For example: Barista at Café Ola."
            />
            {error && (
              <p className="tm-field-error" role="alert">
                {error}
              </p>
            )}
            <div className="welcome-actions">
              <Button variant="quiet" onClick={() => go('hello')}>
                Back
              </Button>
              <Button variant="quiet" onClick={() => go('bio')}>
                Skip
              </Button>
              <Button
                className="welcome-continue"
                type="submit"
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? 'Saving…' : 'Continue'} <Arrow />
              </Button>
            </div>
          </form>
        )}

        {step === 'bio' && (
          <form onSubmit={saveBio} noValidate className="welcome-form">
            <h1
              id={`${id}-title`}
              className="welcome-heading"
              ref={heading}
              tabIndex={-1}
            >
              {firstName
                ? `Nice to meet you, ${firstName}.`
                : 'Nice to meet you.'}
              <span>Say a line about you.</span>
            </h1>
            <TextareaField
              id={`${id}-bio`}
              label="A line about you"
              maxLength={280}
              value={bio}
              onChange={(event) => setBio(event.target.value)}
              placeholder="What you make, who you help, or why a little thanks means a lot."
              hint={`${bio.length}/280 characters. Shown on your page.`}
            />
            {error && (
              <p className="tm-field-error" role="alert">
                {error}
              </p>
            )}
            <div className="welcome-actions">
              <Button variant="quiet" onClick={() => go('about')}>
                Back
              </Button>
              <Button variant="quiet" onClick={() => go('live')}>
                Skip
              </Button>
              <Button
                className="welcome-continue"
                type="submit"
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? 'Saving…' : 'Continue'} <Arrow />
              </Button>
            </div>
          </form>
        )}

        {step === 'live' && (
          <div className="welcome-form">
            <h1
              id={`${id}-title`}
              className="welcome-heading"
              ref={heading}
              tabIndex={-1}
            >
              Ready to put your page online?
            </h1>
            <p className="welcome-copy">
              Right now only you can see it. Once it’s live, anyone with your
              link or QR code can thank you. You can take it offline any time in
              Settings.
            </p>
            {profile.suspended && (
              <Notice tone="neutral" title="Your page can’t go live right now">
                TipMe has paused your page. Your dashboard explains why.
              </Notice>
            )}
            {error && (
              <p className="tm-field-error" role="alert">
                {error}
              </p>
            )}
            <div className="welcome-actions">
              <Button variant="quiet" onClick={() => go('bio')}>
                Back
              </Button>
              <Button variant="quiet" onClick={() => go('done')}>
                Not yet
              </Button>
              <Button
                className="welcome-continue"
                disabled={busy || profile.suspended}
                aria-busy={busy}
                onClick={() => void goLive()}
              >
                {busy ? 'Going live…' : 'Make my page live'} <Arrow />
              </Button>
            </div>
          </div>
        )}
      </div>

      <PagePreview
        handle={profile.handle}
        name={name.trim()}
        role={role.trim()}
        bio={bio.trim()}
      />
    </section>
  );
}
