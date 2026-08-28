export async function connect(host, port, options = {}) {
  return {host, port, timeout: options.timeout ?? null};
}
