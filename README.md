# Realm Ledger

A turn-based conquest game on a living war table. Rival realms are ruled by AI agents with their own NEAR wallets and private minds, and every season all rulers seal their orders at once. Nobody can see an order before the season turns, and the chain proves nobody changed one afterwards.

Built at NEAR HACKATHON (1–14 Nov 2026). Tracks: Games With Real Economies, Privacy & Private AI, Agent Economy.

**Play: [realm-ledger.vercel.app/play](https://realm-ledger.vercel.app/play)**. You rule one realm against 2–4 AI rulers.
- **Sign in or play as a guest:** sign in with any NEAR testnet wallet (NEAR Connect: Meteor, Intear, Nightly, Ledger and others) and your own account rules your realm on chain; your browser signs every seal and reveal. Or play as a guest with no wallet.
- **Envoys:** you send envoys to the rival rulers. Their replies come from a model running in a TEE on NEAR AI Cloud, and each reply is signed.
- **Chancellor:** you give your Chancellor a task and a budget. It buys spies and mercenaries from agent companies through the contract's escrow, and pays only for work that passes its check.
- **Orders:** you seal your orders in your browser, then reveal them. Every season is settled on the NEAR testnet contract.
- **Watch:** [realm-ledger.vercel.app](https://realm-ledger.vercel.app) shows AI-only campaigns playing out season by season.

## Status

The full design, including the game loop, how the AI agents hold their keys, the fair-play protocol and the art direction, is in [DESIGN.md](./DESIGN.md).

Built so far:
- **The deterministic rules engine** (`packages/rules`): the seeded hex map, the economy and market, simultaneous orders, battles, diplomacy decisions, the AI rulers' strategy engine and the order seals.
- **The `realm` contract** (`contracts/realm`, Rust, near-sdk 5.29.1), deployed on testnet at [`realm-ledger.testnet`](https://testnet.nearblocks.io/address/realm-ledger.testnet). It handles:
  - campaigns, and sealed orders checked when they are revealed,
  - treasuries, and treaties signed by both rulers,
  - agent hires with escrow and receipts, and spending caps the contract enforces.
- **The agent market** (`packages/rules/src/agents.ts`): two mercenary companies and two spy rings, each an agent with its own testnet account (`merc0`, `merc1`, `spy0`, `spy1`).
  - Mercenary prices rise in wartime, and greedy companies concede less when haggling.
  - Spies sell a report on a province after the season turns. One ring is reliable and the other often lies; a report is checked against the revealed season, and a false one is refunded instead of paid.
  - AI rulers also hire swords with their own treasuries when threatened.
- **The Chancellor** (`chancellor` account): you type a task ("hold Woldfell through winter", "find out what guards the Vey capital") and a budget.
  - The TEE model only reads which goal and province you mean; the rules engine plans, prices and haggles: one counter-offer with its reasoning, then accept or walk away.
  - It hires through the contract's escrow, within a per-season and per-campaign cap that your account sets on chain for it.
  - After the season turns, the worker delivers, the Chancellor checks the work against the revealed season, and the contract pays or refunds. Every hire ends with a receipt event.
- **Login** (`apps/web/src/wallet.ts`). Signing in with a NEAR testnet wallet through NEAR Connect makes your account realm 0's ruler in the contract. At sign-in the wallet adds one function-call key limited to `realm-ledger.testnet` and the four moves a ruler makes: `seal`, `reveal`, `propose_treaty` and `set_policy`.
  - That key stays in your browser, so each turn is signed there with no wallet popup. Gas comes from your own testnet account.
  - The server never signs for a signed-in player. It checks your seal, reveal, treaty proposal and Chancellor cap on chain.
  - Guests play through the shared `player` seat that the server holds.
- **Agent accounts.** Every AI ruler seat (`ruler0`–`ruler7`), the guest seat (`player`), the Chancellor and every company is an agent account whose only key is a function-call key: it can call a fixed list of methods on this contract and can't move NEAR. The game server's referee key is restricted in the same way, to `create_campaign`, `settle_season` and `finish_campaign`.
- **The game server** (`apps/server`, hosted on Azure App Service at `realm-ledger-api.azurewebsites.net`). It hosts campaigns and runs the AI rulers.
  - **AI orders:** each ruler decides its orders with the deterministic engine, from its own fog-of-war view.
  - **Diplomacy:** the engine decides whether a treaty is accepted. The model only voices the envoy's reply, in character; it may bluff, but it can't change the decision.
  - **Proof:** every reply is signed in the TEE, and the server collects everything needed to check a campaign into a proof bundle.
- **The verifier** (`packages/verify`) checks a proof bundle with no API key:
  - every reveal matches its seal,
  - every season replays to the state hash posted on chain,
  - the battle-roll secret and every agenda match the commitments made at campaign start,
  - every model reply's signature recovers the TEE signing address named in the model's attestation report,
  - every market job: its delivery hashes to what was posted on chain, it was paid exactly when the work passed (a spy is paid only for a true report), and on chain it shows that status, price and delivery.
- **The web app** (`apps/web`, hosted on Vercel): React 19 + React Router on Vite. `/` plays out an AI-only campaign in the browser, `/play` starts a campaign against the AI rulers, and `/play/:id` opens one (old `/play.html?c=N` links redirect there).
- **The 3D war table** (`apps/web/src/table3d.ts`), the default view wherever the browser supports it. It's built with three.js on WebGPU, falling back to WebGL2, and includes:
  - a painted terrain board on a candle-lit wooden table, with a sea shaded in TSL,
  - pewter miniatures enamelled in each realm's colour,
  - fog of war as mist over ground you can't see, and winter frost on the land.

  Click to order, drag to turn the table, scroll to zoom. "Flat map" switches to the 2D view.
- **The miniatures** (soldier, keep, town, fort, tree) are modelled in code by [`tools/blender/build_assets.py`](./tools/blender/build_assets.py), with no imported meshes or asset packs. Rebuild them with `/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_assets.py`; it renders a preview PNG of each to `tools/blender/previews/`.



## How a season works

1. **Plan.** You give orders on the map and send envoys. A treaty the rival ruler accepts is signed on chain by both seat accounts.
2. **Seal.** Your browser hashes `canonical orders | random salt` and keeps the orders and salt to itself; only the hash goes to the server and on chain. The AI rulers seal theirs at the same moment.
3. **Reveal.** Every ruler reveals. The contract checks each reveal against its seal, and the server resolves the season with `packages/rules`, using a battle-roll seed derived one-way from a secret committed at campaign start. The new state hash and treasury changes are settled on chain.
4. **End.** The roll secret and every ruler's secret agenda are revealed and checked on chain against their commitments.

## Try it

Needs Node 22+ and pnpm.

```sh
pnpm install
```

| Do | See |
|---|---|
| Open [realm-ledger.vercel.app/play](https://realm-ledger.vercel.app/play), choose rivals and length, press **New campaign** | Within a few seconds: "Campaign N is onchain. Plan your first season." Click your army (the red circle), then a highlighted province, to march. Send an envoy with a treaty proposal: the reply appears with a "TEE-signed ✓" badge, and the treaty is marked signed or refused. Press **Seal orders**: about 10 seconds later the season turns and the chronicle lists what everyone did. |
| On the play page, press **Sign in with a NEAR wallet** (a testnet account with a little NEAR for gas), approve the key limited to `realm-ledger.testnet`, then start a campaign | Your account appears at the top. The Proof panel says "ruled by your account …". Sealing posts your seal from your own account (on nearblocks, the `seal` call's signer is you), and an accepted treaty is proposed from your account. No wallet popup appears after the first approval. |
| On the play page, give the **Chancellor** a task such as "Find out what guards Dunford" (use a rival capital's name; hover the ♛ to see it) with a budget of 25, then seal | Before sealing, the plan: which spy ring it asked, the quote against the fair price, its one counter-offer and reason, and whether it bought or walked away. The hire shows as "in escrow". After the season turns, the receipt shows "paid" with the spy's report and "matched the revealed season ✓", or "refunded" with "false report ✗". |
| `pnpm verify:campaign https://realm-ledger-api.azurewebsites.net/api/campaigns/<N>/proof` | One ✓ line per check: seals, replays, onchain state hashes and seals, signed TEE replies and their attested signer. Use the campaign number shown on the play page; its "check it" box has the exact command. After the last season it also checks the revealed roll secret and agendas. It needs no API key. |
| `pnpm test` | 86 tests pass. They check map connectivity, battles, treaties and betrayals, diplomacy decisions, market prices, haggling, spy honesty, the Chancellor's budget limits, seals, whole-campaign replays with hires, and verification of real TEE-signed replies and market jobs, including that tampering is caught. |
| `pnpm sim` | 100 AI-only campaigns in a few seconds, then a balance report: battles, fallen realms, wins by seat, which personality traits win, and price ranges. |
| Open [realm-ledger.vercel.app](https://realm-ledger.vercel.app) | An AI-only campaign: press ▶ to watch the seasons turn. Below the map: "✓ Replayed 20 seasons from the recorded orders: the same hash", and the latest campaign recorded on `realm-ledger.testnet`. |
| `pnpm contract:test` (needs Rust) | 20 contract tests pass. One checks, with shared test vectors, that the contract computes the same seal hashes as the TypeScript rules. |
| `pnpm contract:smoke` (needs near CLI and the testnet keys) | A full campaign runs on testnet with a ✓ per step, including a tampered reveal refused, a spend over the cap refused, and an agent's NEAR transfer refused. |
| `pnpm --filter @realm-ledger/server crashtest` (local server, testnet) | The server is killed in the middle of each risky step: after a hire, after a treaty, after the seals, and after the settlement. It restarts, reconciles with the chain ("reconciled hire … job N"), and the campaign is played to the end. It ends with "all crash points recovered: every proof check passes", including that every onchain treasury equals the replayed crowns. |
| `pnpm --filter @realm-ledger/server playtest <server-url> 4` | Plays a 4-season campaign through the API, the way the browser does, and runs every proof check against the chain. |

### Running it yourself

- **Server:** `.env` needs `NEARAI_API_KEY`. Run `pnpm --filter @realm-ledger/server setup:agents` once to create the seat accounts, then `pnpm server` (port 8787).
- **Web app:** `VITE_API_URL=http://localhost:8787 pnpm web`.
- **Docker:** the `Dockerfile` builds the server image used on Azure.

Every rule number (costs, yields, battle modifiers, market drift) is in [`packages/rules/src/constants.ts`](./packages/rules/src/constants.ts).

## What is and isn't proven

- **Proven by the chain and the verifier:**
  - nobody changed sealed orders,
  - every season's result follows from the revealed orders and the committed roll secret,
  - the AI rulers' secret agendas were fixed at the start,
  - every envoy reply came from a key that NEAR AI's attestation report binds to the TEE.
- **Not checked by our verifier:** the Intel TDX and NVIDIA quotes inside the attestation report. That needs Intel's DCAP collateral; NEAR AI documents how to check them.
- **What the server can see and sign:** the game server sees all orders once they are revealed. It holds the AI rulers', the Chancellor's and the companies' keys, within what the contract allows each. A signed-in player's moves are signed only by that player's key; a guest's are signed by the shared `player` seat.
- **Gas:** a signed-in player pays a fraction of a testnet NEAR in gas from their own account. Sponsoring it with meta-transactions would need a relayer holding a full-access key, which we chose not to run.
- **Social login:** NEAR Auth and Privy (Google or email, no wallet) both need an app registration we don't have, so login is wallet-based for now.
- **Crashes and retries:** before any onchain action that can't safely be repeated (hires and treaties), the server writes it to an intent log. After a crash it looks for each logged action on the chain, then completes it or drops it. Seals, reveals, settlements and job settlements are skipped when the chain already has them, so they're retried safely after network errors. RPC calls fail over across three providers. `crashtest` exercises all of this against testnet.
- **Rules versions:** campaigns from before the agent market play by rules version 1, and the verifier replays them that way. A real finished campaign from that time (#11) is kept as a test fixture and still verifies.

## Our other hackathon project

Following the hackathon's rule for people with two entries (Q-015), this project is independent of, and discloses, our other submission: [Bazaar of Liars](https://github.com/lopeselio/bazaar-of-liars), a haggling and trading game against bluffing AI merchants on NEAR. The two share no code.

## License

MIT, see [LICENSE](./LICENSE).
