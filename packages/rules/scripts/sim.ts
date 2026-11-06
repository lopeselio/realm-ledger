// Headless balance check: plays many AI-only campaigns and prints what happened.
//   pnpm sim                 100 campaigns, 5 realms
//   pnpm sim -- 300 6        300 campaigns, 6 realms
//   pnpm sim -- 1 5 myseed   one campaign, with a season-by-season log

import { BASE_PRICE, GOODS, runCampaign, scores, seasonName, troopCount, type GameState, type Good } from '../src/index.ts';

// pnpm may pass a literal "--" through; ignore it
const args = process.argv.slice(2).filter((a) => a !== '--');
const runs = Number(args[0] ?? 100);
const realms = Number(args[1] ?? 5);
const fixedSeed = args[2];
if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(realms) || realms < 2 || realms > 8) {
  console.error('usage: pnpm sim -- [campaigns>=1] [realms 2-8] [seed]');
  process.exit(1);
}

type Trait = 'greed' | 'caution' | 'honour' | 'ambition';
const traits: Trait[] = ['greed', 'caution', 'honour', 'ambition'];

let conquests = 0;
let totalBattles = 0;
let totalFallen = 0;
let totalDeserted = 0;
let totalRejected = 0;
const winnerTraits: Record<Trait, number> = { greed: 0, caution: 0, honour: 0, ambition: 0 };
const allTraits: Record<Trait, number> = { greed: 0, caution: 0, honour: 0, ambition: 0 };
const winsBySeat = new Array<number>(realms).fill(0);
const priceMin: Record<Good, number> = { grain: Infinity, timber: Infinity, iron: Infinity, gold: Infinity };
const priceMax: Record<Good, number> = { grain: 0, timber: 0, iron: 0, gold: 0 };
const atFloor: Record<Good, number> = { grain: 0, timber: 0, iron: 0, gold: 0 };
let priceSamples = 0;
const margins: number[] = [];
const neutralLeft: number[] = [];
const started = Date.now();

for (let i = 0; i < runs; i++) {
  const seed = fixedSeed ?? `sim-${i}`;
  const { state, history } = runCampaign({ seed, realms });
  const events = history.flatMap((h) => h.events);
  if (events.some((e) => e.kind === 'victory' && e.reason === 'conquest')) conquests++;
  totalBattles += events.filter((e) => e.kind === 'battle').length;
  totalFallen += events.filter((e) => e.kind === 'fallen').length;
  totalRejected += events.filter((e) => e.kind === 'rejected').length;
  for (const e of events) if (e.kind === 'upkeep') totalDeserted += troopCount(e.deserted);

  const w = state.winner!;
  winsBySeat[w]!++;
  for (const t of traits) {
    winnerTraits[t] += state.realms[w]!.personality[t];
    for (const r of state.realms) allTraits[t] += r.personality[t] / realms;
  }
  const sc = scores(state).sort((a, b) => b - a);
  if (sc[1]! > 0) margins.push(sc[0]! / sc[1]!);
  neutralLeft.push(state.owner.filter((o) => o === -1).length / state.owner.length);

  // replay prices season by season from the price events
  const price = { ...BASE_PRICE };
  for (const h of history) {
    for (const e of h.events) if (e.kind === 'price') price[e.good] = e.to;
    for (const g of GOODS) {
      priceMin[g] = Math.min(priceMin[g], price[g]);
      priceMax[g] = Math.max(priceMax[g], price[g]);
      if (price[g] <= Math.ceil(BASE_PRICE[g] / 4)) atFloor[g]++;
    }
    priceSamples++;
  }
  if (fixedSeed) printLog(state, history);
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.log(`\n${runs} campaigns, ${realms} realms, ${Date.now() - started} ms`);
console.log(`ended by conquest: ${pct(conquests / runs)}; realms fallen per campaign: ${(totalFallen / runs).toFixed(2)}`);
console.log(`battles per campaign: ${(totalBattles / runs).toFixed(1)}; deserters per campaign: ${(totalDeserted / runs).toFixed(1)}; rejected orders: ${totalRejected}`);
console.log(`winner's score / runner-up's: ${avg(margins).toFixed(2)}; land still neutral at the end: ${pct(avg(neutralLeft))}`);
console.log(`wins by seat: ${winsBySeat.join(' ')}`);
console.log('winner traits vs average (does one trait dominate?):');
for (const t of traits) console.log(`  ${t.padEnd(8)} ${(winnerTraits[t] / runs).toFixed(2)} vs ${(allTraits[t] / runs).toFixed(2)}`);
console.log('prices over all seasons (min-max, % of seasons at the floor):');
for (const g of GOODS) console.log(`  ${g.padEnd(6)} ${priceMin[g]}-${priceMax[g]} (base ${BASE_PRICE[g]}), floor ${pct(atFloor[g] / priceSamples)}`);

function printLog(state: GameState, history: ReturnType<typeof runCampaign>['history']): void {
  for (const h of history) {
    const count = (k: string): number => h.events.filter((e) => e.kind === k).length;
    console.log(
      `season ${String(h.season).padStart(2)} ${seasonName(h.season).padEnd(6)} orders ${h.orders.reduce((n, o) => n + o.orders.length, 0)} ` +
        `battles ${count('battle')} captured ${count('captured')} fallen ${count('fallen')} rejected ${count('rejected')}`,
    );
  }
  for (const r of state.realms) {
    const land = state.owner.filter((o) => o === r.id).length;
    const troops = state.armies.filter((a) => a.realm === r.id).reduce((n, a) => n + troopCount(a), 0);
    console.log(`${r.name.padEnd(24)} ${r.alive ? 'alive ' : 'fallen'} land ${land} troops ${troops} ${JSON.stringify(r.purse)} ${JSON.stringify(r.personality)}`);
  }
}
