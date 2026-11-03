import net from 'node:net';

/** Postgres's own answer when it is full: an ErrorResponse with SQLSTATE 53300, then goodbye. */
function tooManyClients() {
  const fields = Buffer.from(
    'SFATAL\0VFATAL\0C53300\0Msorry, too many clients already\0\0',
  );
  const head = Buffer.alloc(5);
  head.write('E');
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

/**
 * A little door in front of the test Postgres. Counts the connections going through it, and while
 * `full` answers new ones exactly as a full server does.
 */
export async function startPgGate(databaseUrl, { roundTripMs = 0 } = {}) {
  const target = new URL(databaseUrl);
  const open = new Set();
  const gate = { full: false, peak: 0 };
  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    if (gate.full) {
      client.once('data', () => client.end(tooManyClients()));
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname);
    upstream.on('error', () => client.destroy());
    open.add(client);
    gate.peak = Math.max(gate.peak, open.size);
    client.on('close', () => {
      open.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => client.destroy());
    if (roundTripMs === 0) {
      client.pipe(upstream).pipe(client);
      return;
    }
    // Half the delay each way; timers of equal length keep the bytes in order.
    const later = (to) => (chunk) =>
      setTimeout(() => to.writable && to.write(chunk), roundTripMs / 2);
    client.on('data', later(upstream));
    upstream.on('data', later(client));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String(server.address().port);
  return Object.assign(gate, {
    url: url.toString(),
    /** Fills the server: new connections are refused and those it had are gone. */
    fill() {
      gate.full = true;
      for (const client of open) client.destroy();
    },
    drain() {
      gate.full = false;
    },
    openCount: () => open.size,
    close: () =>
      new Promise((resolve) => {
        for (const client of open) client.destroy();
        server.close(resolve);
      }),
  });
}
