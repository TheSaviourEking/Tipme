'use client';
import { SERIOUS_ACTION_WORDS, type SeriousAction } from '@tipme/contracts';
import { answerOf, withFreshCode, type OpsAnswer } from '@/lib/ops-answers';
import { apiFetch, type SessionResult } from '@/lib/session-client';

type Init = Parameters<typeof apiFetch>[1];

export const actionWords = (action: string) =>
  SERIOUS_ACTION_WORDS[action as SeriousAction] ?? action;

let askForCode: (() => Promise<boolean>) | null = null;

/** The admin shell's code prompt. Calls wait on it; with no prompt, they are simply refused. */
export function setFreshCodePrompt(ask: (() => Promise<boolean>) | null): void {
  askForCode = ask;
}

/** Every admin call: asks for a fresh code when, and only when, the server says one is needed. */
export async function opsFetch<T>(
  path: string,
  init?: Init,
): Promise<SessionResult<T>> {
  // Read before the caller's busy state disables the button: a disabled button can't take focus
  // back from the prompt, and keyboard users would be left at the top of the page.
  const from = document.activeElement;
  let asked = false;
  const result = await withFreshCode(
    () => apiFetch<T>(path, init),
    () => {
      asked = true;
      return askForCode?.() ?? Promise.resolve(false);
    },
  );
  if (asked && from instanceof HTMLElement)
    requestAnimationFrame(() => {
      if (from.isConnected) from.focus();
    });
  return result;
}

/** For anything that can wait for a second person: says which of the three happened. */
export async function opsAct<T>(
  path: string,
  init?: Init,
): Promise<OpsAnswer<T>> {
  return answerOf(await opsFetch<T>(path, init));
}
