const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and attribute values. */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ENTITIES[char]!);
