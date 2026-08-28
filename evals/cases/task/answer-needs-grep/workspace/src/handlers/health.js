export function health() {
  return {status: 'ok', uptime: process.uptime()};
}
