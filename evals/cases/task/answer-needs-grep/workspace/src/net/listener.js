import {createServer} from 'node:http';

const HOST = '127.0.0.1';
const PORT = 8080;

export function listen(handler) {
  return createServer(handler).listen(PORT, HOST);
}
