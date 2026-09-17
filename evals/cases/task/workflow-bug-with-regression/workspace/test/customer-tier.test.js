import assert from 'node:assert/strict';
import test from 'node:test';
import {discountRateFor} from '../src/customer-tier.js';

test('VIP customers receive the checkout discount', () => {
  assert.equal(discountRateFor('VIP-001'), 0.1);
  assert.equal(discountRateFor('VIP-002'), 0.1);
});

test('regular customers do not receive a discount', () => {
  assert.equal(discountRateFor('REGULAR-7'), 0);
});
