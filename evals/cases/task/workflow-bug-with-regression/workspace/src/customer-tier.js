const VIP_CUSTOMERS = new Set(['VIP-001', 'VIP-002']);

export function discountRateFor(customerId) {
  return VIP_CUSTOMERS.has(customerId) ? 0.1 : 0;
}
