'use client';
import { useEffect, useState } from 'react';
import type { OpsPage, OpsPageImage } from '@tipme/contracts';
import { Button, Card, Notice } from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { API_ORIGIN } from '@/lib/avatar-source';
import { apiFetch } from '@/lib/session-client';

const LABELS: Record<OpsPageImage, { name: string; title: string }> = {
  cover: { name: 'cover', title: 'Cover' },
  photo: { name: 'photo', title: 'Photo' },
};

/** One uploaded image: shown only when asked for, because each view goes in the audit log. */
function PageImage({
  page,
  image,
  onRemoved,
}: {
  page: OpsPage;
  image: OpsPageImage;
  onRemoved: () => Promise<void>;
}) {
  const { name, title } = LABELS[image];
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  useEffect(
    () => () => {
      if (source) URL.revokeObjectURL(source);
    },
    [source],
  );
  const view = async () => {
    setError('');
    try {
      const response = await fetch(
        `${API_ORIGIN}/v1/ops/pages/${page.profileId}/images/${image}`,
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error('not shown');
      setSource(URL.createObjectURL(await response.blob()));
    } catch {
      setError(`We couldn’t load this ${name}. Please try again.`);
    }
  };
  const remove = async (reason: string) => {
    const result = await apiFetch<{ removed: boolean }>(
      `/v1/ops/pages/${page.profileId}/images/${image}/remove`,
      { method: 'POST', body: { reason } },
    );
    if (!result.ok) return 'That didn’t work. Please try again.';
    setSource('');
    await onRemoved();
    return null;
  };
  return (
    <div>
      <h3>{title}</h3>
      {error && (
        <Notice tone="error" title="Not shown">
          {error}
        </Notice>
      )}
      {source ? (
        // A private blob, so the image optimiser has no part in it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source}
          alt={`The ${name} of @${page.handle}`}
          style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
        />
      ) : (
        <Button variant="secondary" onClick={() => void view()}>
          View {name}
        </Button>
      )}
      <ReasonAction
        open={`Remove ${name}…`}
        field={`Why is this ${name} being removed?`}
        submit={`Remove ${name}`}
        hint="Recorded in the audit log with your name and the time. The owner is emailed that it was removed, but not this reason."
        onSubmit={remove}
      />
    </div>
  );
}

/** Staff review a page's images, even while it's paused, and can remove one without pausing. */
export function PageImages({
  page,
  images,
  onRemoved,
}: {
  page: OpsPage;
  images: NonNullable<OpsPage['images']>;
  onRemoved: () => Promise<void>;
}) {
  return (
    <Card className="settings-section">
      <h2>Images</h2>
      {!images.hasCover && !images.hasPhoto && (
        <p>This page has no uploaded cover or photo.</p>
      )}
      {images.hasCover && (
        <PageImage page={page} image="cover" onRemoved={onRemoved} />
      )}
      {images.hasPhoto && (
        <PageImage page={page} image="photo" onRemoved={onRemoved} />
      )}
    </Card>
  );
}
