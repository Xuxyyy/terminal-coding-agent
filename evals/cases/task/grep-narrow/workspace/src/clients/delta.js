import {connect} from '../net/connect.js';

export async function delta(host, port) {
  const socket = await connect(host, port);
  return socket;
}
