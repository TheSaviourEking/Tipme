'use client';
import type {
  BusinessNoteRequest,
  NoteReport,
  WorkNoteView,
} from '@tipme/contracts';
import { apiFetch, type SessionResult } from '@/lib/session-client';

// PR B5: the web's calls for notes after paying (the ops review calls live with its screen, so
// the public receipt never loads the staff client). The supporter's note goes with the receipt's
// status token and never with a cookie, exactly as the receipt itself reads the tip.

const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

export type NoteSent =
  { ok: true } | { ok: false; code: string; fields?: string[] };

export async function sendBusinessNote(
  tipId: string,
  token: string,
  note: BusinessNoteRequest,
): Promise<NoteSent> {
  let response: Response;
  try {
    response = await fetch(
      `${API_ORIGIN}/v1/tips/${encodeURIComponent(tipId)}/business-note`,
      {
        method: 'POST',
        cache: 'no-store',
        // Staging/preview: every call carries the preview cookie (PR-010); otherwise none.
        credentials:
          process.env.NEXT_PUBLIC_PREVIEW_GATE === 'on'
            ? 'include'
            : API_ORIGIN === ''
              ? 'same-origin'
              : 'omit',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(note),
      },
    );
  } catch {
    return { ok: false, code: 'NETWORK' };
  }
  if (response.status === 204) return { ok: true };
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; fields?: string[] };
  } | null;
  return {
    ok: false,
    code: body?.error?.code ?? 'INTERNAL_ERROR',
    ...(body?.error?.fields ? { fields: body.error.fields } : {}),
  };
}

/** The signed-in person's own notes, every membership. Null when it can't be read. */
export async function loadMyNotes(): Promise<WorkNoteView[] | null> {
  const result = await apiFetch<WorkNoteView[]>('/v1/me/work/notes');
  return result.ok && Array.isArray(result.data) ? result.data : null;
}

export const reportMyNote = (
  tipId: string,
  reason: NoteReport['reason'],
): Promise<SessionResult<undefined>> =>
  apiFetch<undefined>(`/v1/me/work/notes/${encodeURIComponent(tipId)}/report`, {
    method: 'POST',
    body: { reason },
  });
