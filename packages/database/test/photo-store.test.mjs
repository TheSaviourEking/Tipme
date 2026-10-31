import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createR2PhotoStore, r2Settings } from '../dist/photo-store.js';

// The R2 photo store against a fake S3 endpoint: what it sends, and how it reads the answers.

async function fakeS3(t) {
  const objects = new Map();
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization ?? '',
      contentType: req.headers['content-type'] ?? '',
    });
    const key = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.method === 'PUT') {
      objects.set(key, body);
      res.writeHead(200, { ETag: '"etag"' }).end();
    } else if (req.method === 'GET') {
      const found = objects.get(key);
      if (!found)
        res
          .writeHead(404, { 'Content-Type': 'application/xml' })
          .end(
            '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>',
          );
      else res.writeHead(200, { 'Content-Type': 'image/webp' }).end(found);
    } else if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
    } else res.writeHead(400).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const store = createR2PhotoStore({
    accountId: 'acct',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret-example',
    bucket: 'tipme-photos',
    endpoint: `http://127.0.0.1:${server.address().port}`,
  });
  return { store, objects, requests };
}

test('a photo is written, read back and removed, each request signed for the bucket', async (t) => {
  const { store, objects, requests } = await fakeS3(t);
  const webp = Buffer.from('RIFF....WEBPVP8 fake');
  await store.put('avatars/p1/a.webp', webp);
  assert.deepEqual(objects.get('/tipme-photos/avatars/p1/a.webp'), webp);
  assert.equal(requests[0].contentType, 'image/webp');
  assert.match(
    requests[0].authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\//,
  );
  assert.deepEqual(await store.get('avatars/p1/a.webp'), webp);
  await store.remove('avatars/p1/a.webp');
  assert.equal(objects.size, 0);
});

test('a missing photo reads as null, not an error', async (t) => {
  const { store } = await fakeS3(t);
  assert.equal(await store.get('avatars/none.webp'), null);
});

test('R2 settings: all four or none, and none means photos stay in the database', () => {
  assert.equal(r2Settings({}), null);
  assert.deepEqual(
    r2Settings({
      R2_ACCOUNT_ID: 'acct',
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET: 'tipme-photos',
    }),
    {
      accountId: 'acct',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      bucket: 'tipme-photos',
    },
  );
  assert.throws(
    () => r2Settings({ R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'b' }),
    /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/,
  );
});

test('the real endpoint is the account’s R2 address', () => {
  const store = createR2PhotoStore({
    accountId: 'abc123',
    accessKeyId: 'id',
    secretAccessKey: 's',
    bucket: 'b',
  });
  assert.equal(store.endpoint, 'https://abc123.r2.cloudflarestorage.com');
});
