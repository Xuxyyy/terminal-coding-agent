import {connect} from '../net/connect.js';

export async function gamma(host, port) {
  const socket = await connect(host, port);
  return socket;
}
