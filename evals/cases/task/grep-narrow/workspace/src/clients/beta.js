import {connect} from '../net/connect.js';

export async function beta(host, port) {
  const socket = await connect(host, port);
  return socket;
}
