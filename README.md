# Realm Ledger

A turn-based conquest game on a living war table. Rival realms are ruled by AI agents with their own NEAR wallets and private minds, and every season all rulers seal their orders at once. Nobody can see an order before the season turns, and the chain proves nobody changed one afterwards.

Built at NEAR HACKATHON (1–14 Nov 2026). Tracks: Games With Real Economies, Privacy & Private AI, Agent Economy.

**Live: [realm-ledger.vercel.app](https://realm-ledger.vercel.app)**. Watch an AI-only campaign play out season by season on the real rules engine, check that it replays to the same state hash, and see the campaigns recorded by the testnet contract.

## Status

The full design, including the game loop, how the AI agents hold their keys, the fair-play protocol and the art direction, is in [DESIGN.md](./DESIGN.md).

Built so far:
- **The deterministic rules engine** (`packages/rules`): the seeded hex map, the economy and market, simultaneous orders, battles, the AI rulers' strategy engine and the order seals.
- **The `realm` contract** (`contracts/realm`, Rust, near-sdk 5.29.1), deployed on testnet at [`realm-ledger.testnet`](https://testnet.nearblocks.io/address/realm-ledger.testnet). It handles campaigns, sealed orders checked on reveal, treasuries, treaties signed by both rulers, agent hires with escrow and receipts, and spending caps the contract enforces. Agent accounts hold only a function-call key: they can call a fixed list of methods on this contract and can't move NEAR.

- **A campaign viewer** (`apps/web`, hosted on Vercel). It runs the rules engine in the browser and draws the board as a 2D hex map. It replays every campaign from its recorded orders and reads the contract over public testnet RPC.

The game server, the TEE-attested AI diplomacy and the 3D war table come next.

## Try it

Needs Node 22+ and pnpm.

```sh
pnpm install
```

| Do | See |
|---|---|
| `pnpm test` | about 56 tests pass. They check that maps are connected, battles favour fortified defenders, a march onto a peace partner's land breaks the treaty, seals reject altered orders, and that a whole AI campaign replays to the same state hash from its recorded orders. |
| `pnpm sim` | 100 AI-only campaigns in a few seconds, followed by a balance report: battles, fallen realms, wins by seat, which personality traits win, and price ranges for each good. |
| `pnpm sim -- 1 5 myseed` | one campaign on seed `myseed`, logged season by season, with each realm's final land, troops, treasury and personality. |
| Open [realm-ledger.vercel.app](https://realm-ledger.vercel.app), or run `pnpm --filter @realm-ledger/web dev` | A hex map of one campaign. Press ▶ to watch the seasons turn, hover a province for its details, and read the chronicle of battles and captures. Below the map: "✓ Replayed 20 seasons from the recorded orders: the same hash", plus the latest campaign on `realm-ledger.testnet`. Change the seed to play a different campaign; `?seed=...&realms=...` links share it. |
| `pnpm contract:test` (needs Rust) | 20 contract tests pass. One of them checks, with shared test vectors, that the contract computes the same seal hashes as the TypeScript rules. |
| `pnpm contract:smoke` (needs near CLI and the testnet keys) | A full campaign runs on testnet against the live contract. Each step prints a ✓: agents with function-call keys only, seals, a tampered reveal refused, a spy hired with escrow and a receipt, a spend over the cap refused, the season settled, the roll secret and agendas checked against their commitments, and an agent's NEAR transfer refused. |

Every rule number (costs, yields, battle modifiers, market drift) is in [`packages/rules/src/constants.ts`](./packages/rules/src/constants.ts). Each price change carries its reasons (`trade`, `war`, `harvest`, `drift`).

## Our other hackathon project

Following the hackathon's rule for people with two entries (Q-015), this project is independent of, and discloses, our other submission: [Bazaar of Liars](https://github.com/lopeselio/bazaar-of-liars), a haggling and trading game against bluffing AI merchants on NEAR. The two share no code.

## License

MIT, see [LICENSE](./LICENSE).
