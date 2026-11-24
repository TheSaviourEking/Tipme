import { readFile } from 'node:fs/promises';
import { WORDMARK } from './wordmark.ts';

// The staging password page (/preview-login): self-contained by design. Its policy allows inline
// styles and its own data images only, so the logo is a data URL and the text uses the system
// interface font. If the logo file cannot be read the page still answers, with the name in text.

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The light wordmark at the email's 2x size (320 px wide, about 7 kB). */
const readLogoFile = () =>
  readFile(
    new URL('../../public/email/tipme-logo-2026-light-2x.png', import.meta.url),
  );

let logoData: Promise<string> | undefined;

async function logoHtml(read: () => Promise<Buffer>): Promise<string> {
  const own = read !== readLogoFile;
  const data = own
    ? read().then(
        (bytes) => `data:image/png;base64,${bytes.toString('base64')}`,
      )
    : (logoData ??= read().then(
        (bytes) => `data:image/png;base64,${bytes.toString('base64')}`,
      ));
  try {
    const src = await data;
    const height = 36;
    const width = Math.round((height * WORDMARK.width) / WORDMARK.height);
    return `<img class="logo" src="${src}" width="${width}" height="${height}" alt="TipMe">`;
  } catch {
    // A failed read is not kept: the next page tries again.
    if (!own) logoData = undefined;
    return '<p class="logo logo--text">TipMe</p>';
  }
}

export async function previewLoginPage(
  {
    next,
    error = '',
    status = 200,
  }: { next: string; error?: string; status?: number },
  read: () => Promise<Buffer> = readLogoFile,
): Promise<Response> {
  const logo = await logoHtml(read);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>TipMe staging</title><style>
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:#f3f2ee;color:#000;font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:26rem;padding:32px;border:1px solid rgb(20 18 16/9%);border-radius:24px;background:#fffefa;box-shadow:0 1px 1px rgb(20 18 16/8%),0 8px 16px -6px rgb(20 18 16/10%),0 40px 72px -28px rgb(20 18 16/32%)}
.logo{display:block;height:36px;width:auto;margin:0 0 24px}
.logo--text{height:auto;color:#000;font:700 28px/36px ui-sans-serif,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;letter-spacing:-.02em}
h1{margin:0 0 6px;font:400 30px/1.1 Georgia,"Iowan Old Style",serif;letter-spacing:-.02em}
p{margin:0 0 20px;color:#5d5a54}
label{display:block;margin:0 0 6px;font-size:14px;font-weight:700}
input{width:100%;min-height:50px;padding:12px 14px;border:1px solid rgb(20 18 16/14%);border-radius:14px;background:#eeede8;box-shadow:inset 0 1px 2px rgb(20 18 16/11%);font:inherit;color:inherit}
button{width:100%;min-height:50px;margin-top:16px;border:1px solid #000;border-radius:12px;background:#000;color:#fff;font:inherit;font-weight:700;cursor:pointer;box-shadow:0 1px 1px rgb(20 18 16/24%),0 8px 16px -8px rgb(20 18 16/45%)}
input:focus,button:focus{outline:3px solid #7a32f9;outline-offset:3px}
.error{margin:0 0 16px;padding:12px 14px;border-radius:12px;background:#fdecea;color:#9b2820;font-weight:700}
</style></head><body><main>${logo}<h1>TipMe staging</h1><p>Private test copy. All payments and messages are in test mode.</p>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}<form method="post" action="/preview-login"><input type="hidden" name="next" value="${escape(next)}"><label for="password">Staging password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">Open staging</button></form></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
