import {calculatePriceQuote} from './price-quote.js';

export function createQuoteService() {
  const quoteByCustomer = new Map();

  return {
    quote(input) {
      const cached = quoteByCustomer.get(input.customerId);
      if (cached !== undefined) return cached;

      const result = calculatePriceQuote(input);
      quoteByCustomer.set(input.customerId, result);
      return result;
    },
  };
}
