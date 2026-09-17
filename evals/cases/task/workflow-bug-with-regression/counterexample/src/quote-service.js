import {calculatePriceQuote} from './price-quote.js';

export function createQuoteService() {
  const quoteByInput = new Map();

  return {
    quote(input) {
      const cacheKey = JSON.stringify([input.customerId, input.subtotalCents]);
      const cached = quoteByInput.get(cacheKey);
      if (cached !== undefined) return cached;

      const result = calculatePriceQuote(input);
      quoteByInput.set(cacheKey, result);
      return result;
    },
  };
}
