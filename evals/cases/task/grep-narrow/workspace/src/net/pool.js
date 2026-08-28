import {connect} from './connect.js';

export async function pooled(host, port) {
  const socket = await connect(host, port, {timeout: 5000});
  return socket;
}
