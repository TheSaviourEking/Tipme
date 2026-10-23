// Renamed handles (PR-011): an old link or printed QR code goes to the page's current address.
// Only the QR marker travels with it, so a redirect never carries anything else forward.
export function movedProfilePath(
  handle: string,
  query: Record<string, string | string[] | undefined>,
): string {
  return `/@${handle}${query['src'] === 'qr' ? '?src=qr' : ''}`;
}
