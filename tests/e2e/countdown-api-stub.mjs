// The countdown check runs the web app alone. Since the launch time moved to admin (owner, 14 Nov
// 2026, #216), the web asks the API's /health/release first; this stand-in answers that the launch
// is not set in admin, so the web keeps its own PRODUCTION_LAUNCH_AT, as on release day.
import http from 'node:http';

const port = Number(process.argv[2]);
http
  .createServer((request, response) => {
    if (request.url?.split('?')[0] !== '/health/release') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        data: {
          kind: 'test',
          version: 'countdown',
          deploymentMode: 'production',
          paymentsLive: false,
          analytics: false,
          paymentProvider: 'mock',
          business: false,
          display: {
            pilotNotice: { set: false, on: false },
            launch: { set: false, at: null },
          },
        },
      }),
    );
  })
  .listen(port, '127.0.0.1', () =>
    console.log(`countdown api stub on ${port}`),
  );
