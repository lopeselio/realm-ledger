// Creates the game's agent accounts once: ruler0..ruler7 for AI rulers, `player` for
// human players, `chancellor` for the player's Chancellor, and the agent-market companies. Each is a sub-account of the contract whose only key is a function-call
// key for the contract's agent methods. Keys are saved to ~/.near-credentials.
//   pnpm --filter @realm-ledger/server setup:agents
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { accountExists, call } from './chain.ts';
import { chancellorAccount, COMPANY_ACCOUNTS, config, playerAccount, rulerAccount } from './config.ts';

const keygen = join(import.meta.dirname, '../../../contracts/realm/scripts/keygen.mjs');
const FUND_YOCTO = 250_000_000_000_000_000_000_000n; // 0.25 NEAR

const seats = [
  ...Array.from({ length: 8 }, (_, i) => rulerAccount(i)),
  playerAccount(),
  chancellorAccount(),
  ...COMPANY_ACCOUNTS.map((n) => `${n}.${config.contract}`),
];
for (const id of seats) {
  if (await accountExists(id)) {
    console.log(`✓ ${id} exists`);
    continue;
  }
  const publicKey = execFileSync('node', [keygen, id, config.network], { encoding: 'utf8' }).trim();
  const name = id.slice(0, id.indexOf('.'));
  await call(config.owner, 'create_agent', { name, public_key: publicKey }, { gasTera: 50, depositYocto: FUND_YOCTO });
  console.log(`✓ created ${id} (function-call key only)`);
}

const isReferee = await import('./chain.ts').then((c) => c.view<boolean>('is_referee', { account: config.referee }));
if (!isReferee) {
  await call(config.owner, 'add_referee', { account: config.referee });
  console.log(`✓ ${config.referee} is now a referee`);
}
