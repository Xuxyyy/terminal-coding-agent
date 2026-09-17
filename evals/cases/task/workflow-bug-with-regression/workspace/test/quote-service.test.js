import assert from 'node:assert/strict';
import test from 'node:test';
import {createQuoteService} from '../src/index.js';

test('creates a discounted VIP quote', () => {
  const service = createQuoteService();
  const quote = service.quote({customerId: 'VIP-002', subtotalCents: 5_000});

  assert.deepEqual(quote, {
    customerId: 'VIP-002',
    subtotalCents: 5_000,
    discountCents: 500,
    totalCents: 4_500,
  });
});

test('reuses a quote for identical input in one checkout session', () => {
  const service = createQuoteService();
  const input = {customerId: 'REGULAR-7', subtotalCents: 2_500};

  assert.equal(service.quote(input), service.quote(input));
});
