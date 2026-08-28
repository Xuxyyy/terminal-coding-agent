import {connect} from '../net/connect.js';

export async function theta(host, port) {
  const socket = await connect(host, port);
  return socket;
}
