# Realm Ledger — Design

A turn-based conquest game on a living war table. You rule one realm of the Shattered Reach. The rival realms are ruled by AI agents with their own NEAR wallets and private minds, and every season all rulers seal their orders at once. Nobody, including us, can see an order before the season turns, and the chain proves nobody changed one afterwards.

Built for NEAR HACKATHON (1–14 Nov 2026), and kept going after it. Tracks: **Games With Real Economies** (`games`), **Privacy & Private AI** (`privacy`), **Agent Economy** (`agents`).

This document is the source of truth. It is written before any code, as both track prompts ask: the game loop on paper first, and how the agents hold their keys before what they do.

## The pitch in one breath

Every realm, yours included, keeps its treasury, its armies and its secrets on the ledger. The AI rulers bargain with you in plain language, hire mercenaries and spies with their own coins, and lie about their intentions, because their orders are sealed until the season turns. You win by reading them better than they read you.

## Why this fits the three tracks

| Track | What judges look for | What Realm Ledger does |
|---|---|---|
| Games With Real Economies | NPCs with wallets, economies that move without a dev patch, a good game loop, the chain invisible | Rival realms are agent NPCs with their own NEAR accounts. Provinces produce grain, timber, iron and gold, and realms trade them on an open market with prices set by supply. Wars, embargoes and famines move prices; nobody patches them. Players sign in socially and never see gas. |
| Privacy & Private AI | Private inference, nothing leaked, verifiable | Each AI ruler's strategy and memory run on NEAR AI Cloud inside a TEE, and every reply is attested and signed. Orders are sealed onchain each season (commit-reveal), so hidden armies and secret treaties are real hidden information. At campaign end, everything is revealed and anyone can replay it. |
| Agent Economy | Agents that earn, spend, negotiate, hire other agents and pay for data, within a budget | AI rulers hold treasuries, negotiate treaties and trades, hire mercenary companies and spies, and buy intelligence (paying for data). Your **Chancellor** is a general-contractor agent: you give it a task and a budget ("take the Ember Pass by winter, 400 crowns"), it plans, hires, negotiates once, checks the work and pays, with a receipt for every spend. |

## The game loop

**Every 30 seconds**
- Click a province: see its yield, garrison and the rumours about it.
- Issue an order: march, fortify, raise a levy, build, or set a trade.
- Read an envoy's message from a rival ruler, and answer it in your own words.
- Approve or veto one of your Chancellor's proposed spends.

**Every 5 minutes: one season**
1. **Plan.** Orders go on the war table as ghost pieces. Diplomacy happens now: propose a treaty, threaten, bribe, ask for passage. Rivals answer in character and may be lying.
2. **Seal.** All rulers commit their orders at once. Each commitment is a hash posted onchain; the orders themselves stay secret.
3. **Turn.** Orders are revealed and checked against their seals, then resolved together: armies move, battles are fought, harvests come in, prices move. The table animates the season. A ruler who sealed but can't reveal (say the browser holding the orders is gone) forfeits them, and that realm does nothing that season. The ruler can forfeit at once with its own key (`forfeit`), which also blocks a later reveal; otherwise the referee may settle without that reveal once a full season has passed after the seal deadline (the game server does that only for guest seats, and for an AI seat whose reveal can't land; a wallet's orders are given up only by that wallet). `settle_season` names the forfeited realms, and the contract refuses any that revealed, so a reveal can't be dropped. Revealed orders are kept onchain until the season settles, so the referee can resolve it even if the revealing browser never reached the game server. The game server settles such a season itself once its reveal window has closed if the player never came back, which frees what was kept. A guest campaign left sealed is settled the same way a further full season later (with the orders the server kept, or without them), a few per sweep. For a season nobody can settle, the referee can free it by hand (`clear_kept_reveals`, a full season after the reveal window); the server doesn't do that on its own, because a season it can't settle yet may still be recoverable. If a seat the server signs for can't sign its reveal (its key out of gas allowance, gone or not allowed, every RPC saying it doesn't exist, or its account too poor to pay), the referee reveals for it; a contract refusal or a network failure is not handed over. The proof bundle lists forfeited realms.
4. **Report.** A chronicle of what happened, including which promises were broken. Every line links to its proof.

**Every session: one campaign**
- About 20 seasons (30–45 minutes) on a fresh, seeded map with 4–6 realms.
- Win by holding the most crowns of territory and treasury at the last winter, or by taking every rival capital.
- After the campaign, the whole thing is revealed and replayable: every sealed order, every AI decision and signed reply, every battle roll. A verifier (`pnpm verify:campaign`) checks it with no API key.
- Your realm's record (wins, broken treaties, wealth) carries to the leaderboard and to how AI rulers treat you next time.

## Mechanics

- **Map.** A hex map of 60–120 provinces, generated from a seed: coast, plains, forest, hills, mountains, rivers and passes. Each province yields resources, holds at most one army per realm, and may have a fort or a town.
- **Economy.** Four goods (grain, timber, iron, gold) plus **crowns**, the coin. Armies eat grain and are paid in crowns; forts need timber and iron. Realms trade on a market whose prices follow supply and recent trade, so a war in the iron hills makes iron dear everywhere. All pricing rules live in one readable file, and each price shows its reasons.
- **Armies.** Levies (cheap, weak), regulars (paid upkeep) and hired mercenary companies. Battles are resolved from strength, terrain, forts, supply and a seeded roll that is committed before the season, so outcomes can be replayed and checked.
- **Fog of war.** You see your own provinces, your neighbours and whatever your spies report. Army positions you can't see are covered by the season's commitment: they're real, fixed and checkable later, but hidden now. The chronicle and the season's playback show it as your realm saw it: your own events, whatever happened in provinces you saw at its start or end or had a spy report from (a rival's march only if it ends in sight, so a march into the fog doesn't say where it went), and public news (market trades and prices, tribute, fallen realms, and broken treaties, though where one happened only if you saw it). The final season shows in full once the campaign ends; every season is in the proof bundle all along. Revealed orders are public onchain each season, so the fog is a courtesy of the game's own screens, not a secret from someone reading the chain.
- **Diplomacy.** Treaties (peace, passage, trade, alliance, tribute) are signed onchain by both rulers' accounts. Breaking one is possible, but public once revealed, and every AI ruler remembers it.
- **Simultaneous orders.** Nobody moves first, so there is no advantage in watching others. Two armies entering the same province fight; two armies swapping provinces meet on the border.

## The rival rulers (AI agents)

- **Who they are.** Each rival realm has a ruler with a personality (greed, caution, honour, ambition) and a secret agenda drawn at campaign start ("wants the iron hills", "owes a blood debt to the north"). The agenda is committed onchain at the start and revealed at the end.
- **What decides their moves.** A deterministic strategy engine scores options (expand, fortify, trade, betray) from the realm's state and its personality. The language model never chooses an order; it voices diplomacy and turns your words into proposals. This is the same separation that keeps Bazaar of Liars fair, rebuilt for this game.
- **Private minds.** The ruler's agenda, memory of you and diplomatic reasoning are sent only to an attested TEE model on NEAR AI Cloud, and every reply is signed. You can't see them during the campaign; the proof shows they weren't changed.
- **Lying is allowed.** A ruler can promise peace and seal an attack. The seal proves what it really ordered, and once revealed, broken promises are public.

## Agent economy

**How the agents hold their keys, and what they can't do.** This is settled before anything else, as the Agent Economy prompt asks.
- Every agent has its own NEAR account: each AI ruler, each mercenary captain, each spy and your Chancellor.
- Each account has one key, a **function-call key** limited to the Realm Ledger contract and a short list of methods (seal orders, sign a treaty, hire, pay). There is no full-access key, so an agent can't move NEAR, call another contract or drain anything.
- The contract enforces each agent's policy:
  - a per-season and per-campaign spending cap;
  - no spend without the agent's own signature;
  - a hired agent is paid only when its work is delivered (a spy's report is posted, a mercenary company marches).
- The game server holds the agents' keys (`~/.near-credentials` locally, a secret store when hosted). It can sign as an agent, but only within what the contract allows that agent.
- What needs you: anything that spends your realm's treasury above the Chancellor's budget, any treaty in your name, and declaring war.

**The agent market.**
- **Mercenary companies** are agents that sell their swords per season. Their price rises in wartime, and they haggle.
- **Spies** sell intelligence about a province or a ruler. It's paying for data, and the report is checked against the reveal at season's end: a spy who sold a false report loses reputation and future fees.
- **Envoys** carry proposals between realms for a small fee.
- If the NEAR AI Agent Market supports posting and paying jobs programmatically, contracts for spies and envoys will also be posted there. We check before building on it (open question 2).

**The Chancellor (your general-contractor agent).** This is the in-game terminal.
- You type a task and a budget: "Hold the Ember Pass through winter, 400 crowns."
- It breaks the task into parts: what it can do with your armies, what it must buy (mercenaries, a spy on the pass, timber for a fort).
- It asks for quotes, and when a quote is over plan it **counters once with its reasoning**, then accepts or walks away.
- It checks the work (the spy's report against the season reveal, the mercenaries actually at the pass) and pays only then.
- Every spend gets a **receipt**: what was bought, from whom, at what price, and whether the work passed its check. Receipts are onchain events.
- Everything it spends stays inside your budget, and the contract enforces that.

**Modding through the terminal.** The same terminal accepts `mod` commands: describe a new unit, rule or event in plain language, and the Chancellor writes it as a script against a documented mod API. Mods run in a sandboxed Web Worker with no network and no keys, apply only to your own campaigns, and are recorded in the campaign's proof so replays stay exact.

**Which model the terminal uses.** The default is a TEE-attested NEAR AI Cloud model, which keeps the Privacy track's guarantees. Claude via the Anthropic API could be an opt-in alternative for modding; it would need an API key and would not count as private inference (open question 3).

## Fair play: what the chain proves

1. **Campaign start.** Each realm's agenda, the map seed and the battle-roll seed are committed onchain.
2. **Each season.**
   - Every ruler, human or AI, posts `sha256(orders | salt)` before the season turns.
   - After all seals are in (or the timer ends), the orders are revealed.
   - The contract checks each reveal against its seal and settles what must be settled onchain: treasury movements, hires and treaty signatures.
3. **Campaign end.**
   - Agendas and seeds are revealed.
   - The proof bundle holds every seal, reveal, signed model reply and attestation.
   - Anyone can replay the full campaign deterministically and check that it matches.

**What it doesn't prove**, which the README will say plainly: during the campaign, the game server that resolves battles sees all orders after they're revealed, and it holds the agents' keys. Moving that referee into a TEE (a Shade Agent or OutLayer) would close the gap; it's a stretch goal, not a promise.

## Art direction: a living war table

The look is a **painted miniature war table at night**.
- The map is a carved, painted terrain board on a wooden table, lit by candles and a lamp.
- Realms are painted pewter-and-enamel miniatures.
- Banners are cloth, the sea is glazed resin, and fog of war is real drifting fog over the unknown provinces.
- Seasons change the board's paint: summer greens, autumn ochre, winter frost creeping in from the edges.

Why this direction:
- It's **original**: we don't imitate any existing strategy game's look.
- It's **polished on a hackathon budget**: miniatures and a board forgive simple shapes, and lighting, materials and post-processing do the heavy lifting.
- It **reads as a game instantly** in the demo video and in a thumbnail.

**How the 3D assets get made**
- **Terrain is procedural, in code.** Hex tiles are extruded from the map seed, with height from noise, biome materials, carved cliff edges and river channels. The sea is a TSL shader with depth tint and foam. Every campaign map is unique.
- **Miniatures and buildings are made in Blender from scripts we write** (Blender 4.4 is installed locally). Python `bpy` scripts in `tools/blender/` build each model with modifiers and geometry nodes: soldiers, cavalry, siege engines, keeps, towns, ships and the table props. They bake ambient occlusion and paint masks and export compressed `.glb` files. The scripts live in the repo, so anyone can rebuild every asset with `pnpm assets`.
- I run Blender headless (`Blender -b -P script.py`) and render a preview of each asset to PNG to review it. No Blender MCP is needed. A Blender MCP server would make interactive editing faster; it's optional, and you would need to install it yourself.
- **Realm colours are applied at runtime,** like paint on a miniature: one model, any number of realms.
- **Materials and textures:** our own procedural textures (wood grain, parchment, cloth), plus CC0 HDRIs and textures from Poly Haven where useful, credited in the README. No paid or AI-generated asset packs, so every asset is ours and licence-clean.
- **Rendering:** three.js on WebGPU with TSL, falling back to WebGL.
  - Soft shadows from the candle and lamp, AO and a warm filmic grade.
  - A subtle tilt-shift depth of field that sells the miniature scale.
  - Particle fog, dust in the lamp light, and embers when a province burns.
- **Animation:** pieces slide and hop between hexes on a season turn, battles play as a short clash of miniatures with dust and a dice roll, and banners ripple. The camera eases between the whole board and a province close-up.
- **Sound:** a quiet room tone, wood-on-wood when pieces land, and a horn at each season turn. It's synthesised or CC0, credited.

## Architecture

```
apps/web         three.js war table (Vite, TypeScript, WebGPU/TSL), chancellor terminal, diplomacy chat
apps/server      campaign host: seasons, seals, reveal + resolution, AI rulers, agent market, NEAR AI calls
packages/rules   deterministic map gen, economy, battles, AI strategy engine (pure, seeded, tested)
packages/verify  campaign replay verifier (no API key)
packages/mods    sandboxed mod API (Web Worker)
contracts/realm  Rust near-sdk contract: campaigns, seals, reveals, treasuries, treaties, hires, receipts
tools/blender    bpy scripts that build every 3D asset to .glb
```

- **NEAR:** testnet. A `realm` contract written from scratch with near-sdk, plus agent sub-accounts with function-call keys. Verify endpoints and SDK versions against docs.near.org/llms.txt.
- **Login:** social or email login with no seed phrases or gas prompts. The provider is chosen after checking what works on testnet today (open question 1).
- **Optional:** NEAR Intents for paying out a campaign prize or tribute in another token, if time allows.

## Independence from Bazaar of Liars

The hackathon allows one person two projects if they're independent and each README names the other (rule Q-015).
- Realm Ledger is a separate game with its own repo, contract, rules, art and server.
- It reuses ideas proven in Bazaar of Liars (the LLM voices but never decides, commit-reveal, TEE attestation), but no code is copied in.
- It is also not a port of Cryptara Conquest. It's a new codebase, written from 2026-11-06.

## Plan

The full scope stays; it's built in this order so there's always something playable.

1. **Rules on paper, then in code.** `packages/rules`: seeded map, economy, battles and the AI strategy engine, with a headless simulation of AI-only campaigns to check balance. *(First.)*
2. **The `realm` contract.** Campaigns, seals and reveals, treasuries, treaties, hires and receipts; agent accounts with function-call keys; unit tests.
3. **The war table.** apps/web: procedural board, Blender-scripted miniatures, orders, the season-turn animation.
4. **AI rulers.** TEE-attested diplomacy on NEAR AI Cloud, a signed-reply proof bundle, and the campaign verifier.
5. **Agent market and Chancellor.** Mercenaries, spies, envoys; task + budget + receipts; then the modding terminal.
6. **Polish and ship.** Login, sound, hosted demo (kept up through 2026-11-25), demo video, X post.

For the hackathon deadline (2026-11-14 23:59 UTC), steps 1–4 must be solid and step 5 must at least show one full Chancellor task with receipts. Work continues after the deadline.

## Open questions

1. Which social login and gas-sponsoring setup works on testnet today (checked against the NEAR docs before building). *Checked 2026-11-06:*
   - **Login:** docs.near.org lists NEAR Auth (Google, Apple, email or passkeys via MPC, no seed phrase), Privy, and the NEAR Connect wallet connector.
   - **Gas:** gas-free play uses NEP-366 meta-transactions, and the docs name no hosted testnet relayer, so we run our own.
   - **Decided 2026-11-07:** wallet login through NEAR Connect, plus the function-call-key plugin, so a signed-in player's browser signs every turn itself. Guests keep a shared seat. NEAR Auth and Privy would add Google and email login, but each needs an app registration (an Auth0 client ID, or a Privy app).
2. Can jobs be posted and paid on the NEAR AI Agent Market programmatically? If not, the agent market stays inside the game, and the README says so. *Checked 2026-11-06:* docs.near.ai documents no Agent Market API, so the agent market lives in the `realm` contract (hire, deliver, settle, receipts). Built 2026-11-07: mercenary companies and spy rings as agent accounts, the Chancellor, and AI rulers hiring.
3. Should the terminal offer Claude as an opt-in alternative to the NEAR AI model for modding? (Default: NEAR AI only.)
4. How long is a season turn in a live multiplayer game? Single-player against AI comes first.
