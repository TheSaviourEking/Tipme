import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  homeStructuredData,
  serializeJsonLd,
} from '../src/lib/structured-data.ts';

const input = {
  origin: 'https://tipme.example',
  logoPath: '/icons/192.png',
  siteDescription: 'Site words.',
  homeDescription: 'Home words.',
};

test('the homepage graph is an Organization and a WebSite with absolute URLs', () => {
  const data = homeStructuredData(input);
  assert.equal(data['@context'], 'https://schema.org');
  const [org, site] = data['@graph'];
  assert.equal(org['@type'], 'Organization');
  assert.equal(site['@type'], 'WebSite');
  assert.equal(org.name, 'TipMe');
  assert.equal(site.name, 'TipMe');
  assert.equal(org.url, 'https://tipme.example/');
  assert.equal(site.url, 'https://tipme.example/');
  assert.equal(org.logo, 'https://tipme.example/icons/192.png');
  assert.equal(org.description, 'Site words.');
  assert.equal(site.description, 'Home words.');
  assert.equal('sameAs' in org, false);
});

test('no ratings, prices, reviews or licensing claims', () => {
  const text = serializeJsonLd(homeStructuredData(input));
  assert.doesNotMatch(
    text,
    /aggregateRating|review|offers|price|licen[cs]e|regulat/i,
  );
});

test('serialized JSON parses and has no raw < for a script tag', () => {
  const data = homeStructuredData({
    ...input,
    homeDescription: '</script><script>alert(1)</script>',
  });
  const text = serializeJsonLd(data);
  assert.equal(text.includes('<'), false);
  assert.deepEqual(JSON.parse(text), data);
});
