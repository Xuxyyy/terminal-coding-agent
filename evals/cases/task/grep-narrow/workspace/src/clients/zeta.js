import {connect} from '../net/connect.js';

export async function zeta(host, port) {
  const socket = await connect(host, port);
  return socket;
}
