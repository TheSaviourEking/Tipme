'use client';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Card, InputField } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

// Your data and page (ScreenSettings).

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
          : 'We couldn’t delete your page. Please try again.',
    );
  };
  return (
    <Card className="settings-section settings-section--danger">
      <h2>Delete page</h2>
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
