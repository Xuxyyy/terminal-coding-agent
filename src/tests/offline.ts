import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const offlineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-offline-home-'));
process.env.ACC_HOME = offlineHome;
process.once('exit', () => fs.rmSync(offlineHome, {recursive: true, force: true}));

process.env.DEEPSEEK_API_KEY = '';
delete process.env.ACC_MODEL_RELAY_URL;
delete process.env.ACC_MODEL;
delete process.env.ACC_REASONING_EFFORT;
