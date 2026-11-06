# Realm Ledger

A turn-based conquest game on a living war table. Rival realms are ruled by AI agents with their own NEAR wallets and private minds, and every season all rulers seal their orders at once. Nobody can see an order before the season turns, and the chain proves nobody changed one afterwards.

Built at NEAR HACKATHON (1–14 Nov 2026). Tracks: Games With Real Economies, Privacy & Private AI, Agent Economy.

## Status

The full design, including the game loop, how the AI agents hold their keys, the fair-play protocol and the art direction, is in [DESIGN.md](./DESIGN.md).

Built so far: **the deterministic rules engine** (`packages/rules`). It covers the seeded hex map, the economy and market, simultaneous orders, battles, the AI rulers' strategy engine and the order seals. The contract, server and war table come next.

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

Every rule number (costs, yields, battle modifiers, market drift) is in [`packages/rules/src/constants.ts`](./packages/rules/src/constants.ts). Each price change carries its reasons (`trade`, `war`, `harvest`, `drift`).

## Our other hackathon project

Following the hackathon's rule for people with two entries (Q-015), this project is independent of, and discloses, our other submission: [Bazaar of Liars](https://github.com/lopeselio/bazaar-of-liars), a haggling and trading game against bluffing AI merchants on NEAR. The two share no code.

## License

MIT, see [LICENSE](./LICENSE).
