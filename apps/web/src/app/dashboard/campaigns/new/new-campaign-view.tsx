'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import {
  CAMPAIGN_NAME_MAX,
  CAMPAIGN_SLUG_PATTERN,
  type CampaignRow,
} from '@tipme/contracts';
import { Button, Card, InputField } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { slugFromName } from '@/lib/campaign-link';
import { apiFetch } from '@/lib/session-client';
import { useOrigin } from '../campaigns-view';

export default function NewCampaignPage() {
  const id = useId();
  const router = useRouter();
  const { profile } = useRecipient();
  const origin = useOrigin();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  // Until the person types an ending of their own, it follows the name.
  const [ownSlug, setOwnSlug] = useState(false);
  const [error, setError] = useState<{
    field: 'name' | 'slug' | 'form';
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const ending = ownSlug ? slug : slugFromName(name);
  const prefix = `${origin.replace(/^https?:\/\//, '') || 'usetipme.xyz'}/@${profile.handle}/`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError({ field: 'name', text: 'Give the campaign a name.' });
      return;
    }
    if (!CAMPAIGN_SLUG_PATTERN.test(ending)) {
      setError({
        field: 'slug',
        text: 'Use lower-case letters, numbers and dashes, up to 30, not starting or ending with a dash.',
      });
      return;
    }
    setBusy(true);
    const result = await apiFetch<CampaignRow>('/v1/me/campaigns', {
      method: 'POST',
      body: { name: name.trim(), slug: ending },
    });
    setBusy(false);
    if (result.ok) {
      router.push(`/dashboard/campaigns/${result.data.id}`);
      return;
    }
    if (
      result.code === 'CAMPAIGN_SLUG_TAKEN' ||
      result.code === 'CAMPAIGN_SLUG_UNAVAILABLE'
    )
      setError({
        field: 'slug',
        text:
          result.code === 'CAMPAIGN_SLUG_TAKEN'
            ? 'You already have a campaign with that link. Try another.'
            : 'That link ending can’t be used. Try another one.',
      });
    else
      setError({
        field: 'form',
        text:
          result.code === 'CAMPAIGN_LIMIT'
            ? 'You’ve used all your campaigns. Stop one to make another.'
            : 'We couldn’t make the campaign. Please try again.',
      });
  };

  return (
    <div className="dashboard-section campaign-new">
      <p className="campaign-crumb">
        <Link href="/dashboard/campaigns">Campaigns</Link> / New
      </p>
      <h1>New campaign</h1>
      <p className="tm-hint">
        Give it a name only you will see, and a link ending people will.
      </p>
      <Card>
        <form
          aria-label="New campaign"
          className="campaign-form"
          onSubmit={submit}
          noValidate
        >
          <InputField
            id={`${id}-name`}
            label="Name"
            hint={`Only you see this. Up to ${CAMPAIGN_NAME_MAX} characters.`}
            maxLength={CAMPAIGN_NAME_MAX}
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...(error?.field === 'name' ? { error: error.text } : {})}
          />
          <div className="tm-field">
            <label htmlFor={`${id}-slug`}>Link</label>
            <p id={`${id}-slug-hint`} className="tm-hint">
              Made from the name; you can change it. Anyone who gets the link
              sees this part, so keep it something you’re happy to share.
              Letters, numbers and dashes.
            </p>
            <div className="campaign-slug">
              <span aria-hidden="true">{prefix}</span>
              <input
                id={`${id}-slug`}
                className="tm-input"
                value={ending}
                maxLength={30}
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={error?.field === 'slug'}
                aria-describedby={`${id}-slug-hint${error?.field === 'slug' ? ` ${id}-slug-error` : ''}`}
                onChange={(e) => {
                  setOwnSlug(true);
                  setSlug(e.target.value.toLowerCase());
                }}
              />
            </div>
            {error?.field === 'slug' && (
              <p
                className="tm-field-error"
                id={`${id}-slug-error`}
                role="alert"
              >
                {error.text}
              </p>
            )}
          </div>
          {error?.field === 'form' && (
            <p className="tm-field-error" role="alert">
              {error.text}
            </p>
          )}
          <Button variant="continue" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create campaign'}
          </Button>
        </form>
      </Card>
      <Card className="campaign-about">
        <h2>What a campaign is, and isn’t</h2>
        <ul>
          <li>
            It is a link to your normal tip page. Supporters see your page
            exactly as always, with no campaign name.
          </li>
          <li>No goal, no target amount, no end date, no stated cause.</li>
          <li>
            Stopping a campaign keeps its results; its link then opens your page
            like your usual link, so printed QR codes never break.
          </li>
          <li>
            A link ending can’t be one of TipMe’s own words or another person’s
            handle.
          </li>
        </ul>
      </Card>
    </div>
  );
}
