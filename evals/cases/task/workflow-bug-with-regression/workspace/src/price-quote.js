import {discountRateFor} from './customer-tier.js';

export function calculatePriceQuote({customerId, subtotalCents}) {
  const discountCents = Math.round(
    subtotalCents * discountRateFor(customerId),
  );

  return Object.freeze({
    customerId,
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
  });
}
