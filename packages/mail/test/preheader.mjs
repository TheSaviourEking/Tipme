/** The hidden preview text of a rendered email: what lock screens and inbox lists show. */
export function preheaderOf(html) {
  const match = /<div data-preheader[^>]*>([\s\S]*?)<\/div>/.exec(html);
  if (!match) return '';
  return match[1]
    .replace(/&(?:zwnj|nbsp|#847|#8204|#160);/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
