// Generates an ed25519 key pair for a NEAR account and saves it where near CLI's
// legacy keychain looks: ~/.near-credentials/<network>/<account>.json. Prints the public key.
// Keys never go in the repo.
//   node keygen.mjs <account> [network]
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [account, network = 'testnet'] = process.argv.slice(2);
if (!account) {
  console.error('usage: node keygen.mjs <account> [network]');
  process.exit(1);
}
const dir = join(homedir(), '.near-credentials', network);
const file = join(dir, `${account}.json`);
if (existsSync(file)) {
  console.log(JSON.parse(readFileSync(file, 'utf8')).public_key);
  process.exit(0);
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
const public_key = `ed25519:${base58(pub)}`;
const private_key = `ed25519:${base58(Buffer.concat([seed, pub]))}`;
mkdirSync(dir, { recursive: true });
writeFileSync(file, JSON.stringify({ account_id: account, public_key, private_key }), { mode: 0o600 });
console.log(public_key);
