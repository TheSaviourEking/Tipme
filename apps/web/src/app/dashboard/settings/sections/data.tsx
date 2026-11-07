'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Card, InputField } from '@tipme/ui';
import { loadBusinessRoles } from '@/lib/business/roles-api';
import { apiDownload, apiFetch } from '@/lib/session-client';
import { SettingsChapter } from './section';

// Your data and page (ScreenSettings): a copy of your tips, and deleting the page.

/** The same file, and the same request, as Download as CSV on Tips. */
function TipsExport() {
  const [note, setNote] = useState('');
  const download = async () => {
    setNote('Preparing your file…');
    const day = new Date().toISOString().slice(0, 10);
    const result = await apiDownload(
      '/v1/me/exports/tips.csv',
      `tipme-tips-${day}.csv`,
    );
    setNote(
      result.ok
        ? 'Downloaded. It has the date, supporter name, amounts, status and the last 6 characters of each reference. Messages stay private.'
        : 'We couldn’t prepare the file. Please try again.',
    );
  };
  return (
    <Card className="settings-section">
      <h3>Your tips</h3>
      <p className="tm-hint">
        A file of your paid and confirming tips: the date, the supporter’s name,
        what they tipped, TipMe’s fee, what you received, the status, and the
        last 6 characters of the reference. A tip made at a business also shows
        the business and the note written about you. Messages stay private and
        are left out.
      </p>
      <Button variant="secondary" onClick={() => void download()}>
        Download as CSV
      </Button>
      <p role="status" className="tm-hint">
        {note}
      </p>
    </Card>
  );
}

/**
 * Where your page has worked (plan B9 Task 24): every business and location, left ones included.
 * Shown only while businesses are on (the roles read answers 404 when they are off).
 */
function WorkExport() {
  const [on, setOn] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    void loadBusinessRoles().then((roles) => setOn(roles !== null));
  }, []);
  if (!on) return null;
  const download = async () => {
    setNote('Preparing your file…');
    const day = new Date().toISOString().slice(0, 10);
    const result = await apiDownload(
      '/v1/me/exports/work.csv',
      `tipme-work-${day}.csv`,
    );
    setNote(
      result.ok
        ? 'Downloaded. It lists each business and location you joined, what you chose to show, and when you joined and left.'
        : 'We couldn’t prepare the file. Please try again.',
    );
  };
  return (
    <Card className="settings-section">
      <h3>Where you work</h3>
      <p className="tm-hint">
        A file of every business and location your page joined, including ones
        you left: the name you show, whether your photo shows, whether you share
        your amounts, and when you joined and left. The notes written about you
        are in your tips file.
      </p>
      <Button variant="secondary" onClick={() => void download()}>
        Download where you work
      </Button>
      <p role="status" className="tm-hint">
        {note}
      </p>
    </Card>
  );
}

export function DeletePage() {
  const id = useId();
  const router = useRouter();
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const remove = async (event: FormEvent) => {
    event.preventDefault();
    if (confirm !== 'DELETE') {
      setError('Type DELETE to confirm.');
      return;
    }
    const result = await apiFetch('/v1/me/account', {
      method: 'DELETE',
      body: { confirm },
    });
    if (result.ok) {
      router.replace('/');
      return;
    }
    setError(
      result.code === 'HAS_BALANCE'
        ? 'You can’t delete your page while money is still confirming or in your balance.'
        : result.code === 'STAFF_CANNOT_DELETE'
          ? 'Staff accounts can’t be deleted. Ask an owner to remove your staff access first.'
          : result.code === 'BUSINESS_LAST_OWNER'
            ? 'You’re the only owner of a business on TipMe. Make someone else an owner of it first.'
            : 'We couldn’t delete your page. Please try again.',
    );
  };
  return (
    <Card className="settings-section settings-section--danger">
      <h3>Delete page</h3>
      <p>
        This removes your page and your details. Records of past tips are kept,
        as the law requires, without your details. Your handle is held for 90
        days.
      </p>
      <form onSubmit={remove} noValidate className="settings-form">
        <InputField
          id={`${id}-confirm`}
          label="Type DELETE to confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={error || undefined}
          autoComplete="off"
        />
        <Button type="submit" variant="secondary">
          Delete my page and account
        </Button>
      </form>
    </Card>
  );
}

export function DataSection() {
  return (
    <SettingsChapter id="data">
      <TipsExport />
      <WorkExport />
      <DeletePage />
    </SettingsChapter>
  );
}
