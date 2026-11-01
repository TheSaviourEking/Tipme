// Loaded with `node --import` into API and worker processes started in production mode, so they
// can run bachs-live with no way of reaching the real provider. Bachs and the alert address go to
// a local stand-in (STAND_IN_ORIGIN); anything else off this machine is refused. Node stops before
// the app runs if this file fails to load.
import { syncBuiltinESMExports } from 'node:module';
import tls from 'node:tls';

const standIn = process.env.STAND_IN_ORIGIN;
if (!standIn || !new URL(standIn).hostname.match(/^127\.0\.0\.1$/))
  throw new Error('STAND_IN_ORIGIN must be a local address');

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (['127.0.0.1', 'localhost'].includes(url.hostname))
    return realFetch(input, init);
  if (url.hostname.endsWith('bachs.io') || url.hostname.endsWith('.test'))
    return realFetch(
      new URL(`/${url.hostname}${url.pathname}${url.search}`, standIn),
      init,
    );
  return Promise.reject(new TypeError(`blocked: ${url.hostname}`));
};
// Other clients (the mail SDK, say) use TLS directly; nothing here should.
tls.connect = () => {
  throw new Error('blocked: outgoing TLS in a local production-mode test');
};
syncBuiltinESMExports();
