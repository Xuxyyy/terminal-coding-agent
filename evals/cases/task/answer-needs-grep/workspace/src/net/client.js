export async function fetchJson(url) {
  const reply = await fetch(url);
  return reply.json();
}
