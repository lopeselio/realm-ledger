import { fight, type BattleSide } from './battle.ts';
import {
  CAPITAL_CROWNS,
  COST,
  GRAIN_FACTOR,
  MAX_FORT,
  NEUTRAL,
  SPOIL_PCT,
  STORE_LIMIT,
  TOWN_CROWNS,
  TROOPS_PER_GRAIN,
  UPKEEP,
} from './constants.ts';
import { moveStock, settleMarket, sellPrice } from './market.ts';
import {
  addTroops,
  armyAt,
  friendly,
  noTroops,
  normaliseArmies,
  pickTroops,
  scores,
  strength,
  treatyBetween,
  troopCount,
} from './state.ts';
import { GOODS, type GameEvent, type GameState, type Good, type Order, type OrderSet, type Purse, type Troops } from './types.ts';

export interface ResolveOptions {
  /** the season's battle-roll seed, committed onchain before orders are sealed */
  rollSeed: string;
}

export interface SeasonResult {
  state: GameState;
  events: GameEvent[];
}

type Cost = Partial<Purse>;
const canPay = (p: Purse, c: Cost, times = 1): boolean =>
  (Object.keys(c) as (keyof Purse)[]).every((k) => p[k] >= (c[k] ?? 0) * times);
const pay = (p: Purse, c: Cost, times = 1): void => {
  for (const k of Object.keys(c) as (keyof Purse)[]) p[k] -= (c[k] ?? 0) * times;
};
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

interface Contingent {
  realm: number;
  troops: Troops;
  /** origin province for troops that marched in, null for troops already here */
  from: number | null;
}

/**
 * Resolves one season from every realm's (revealed) orders. Pure: the input state is
 * not modified. All orders take effect simultaneously, in fixed phases:
 * trade, build, march, battle, capture, harvest, upkeep, market.
 */
export function resolveSeason(prev: GameState, orderSets: OrderSet[], opts: ResolveOptions): SeasonResult {
  if (prev.winner !== null) throw new Error('campaign is over');
  const s = structuredClone(prev);
  const events: GameEvent[] = [];
  for (const g of GOODS) s.market.reasons[g] = [];

  const orders = new Map<number, Order[]>();
  for (const set of orderSets) {
    if (set.season !== s.season) throw new Error(`orders for season ${set.season}, resolving ${s.season}`);
    if (orders.has(set.realm)) throw new Error(`two order sets for realm ${set.realm}`);
    const realm = s.realms[set.realm];
    if (!realm) throw new Error(`no realm ${set.realm}`);
    if (!realm.alive) {
      for (const o of set.orders) events.push({ kind: 'rejected', realm: set.realm, order: o, reason: 'realm has fallen' });
      continue;
    }
    orders.set(set.realm, set.orders);
  }
  const alive = s.realms.filter((r) => r.alive).map((r) => r.id);
  const of = (realm: number): Order[] => orders.get(realm) ?? [];
  const reject = (realm: number, order: Order, reason: string): void => {
    events.push({ kind: 'rejected', realm, order, reason });
  };

  trades(s, alive, of, reject, events);
  builds(s, alive, of, reject, events);
  const pillaged = movement(s, alive, of, reject, events, opts.rollSeed);
  captures(s, events);
  harvest(s, pillaged, events);
  upkeep(s, events);
  for (const change of settleMarket(s.market)) events.push({ kind: 'price', ...change });

  if (s.lastBattles !== undefined) s.lastBattles = events.filter((e) => e.kind === 'battle').length;
  s.season += 1;
  const standing = s.realms.filter((r) => r.alive);
  if (standing.length === 1) {
    s.winner = standing[0]!.id;
    events.push({ kind: 'victory', realm: s.winner, reason: 'conquest', scores: scores(s) });
  } else if (s.season >= s.maxSeasons) {
    const sc = scores(s);
    let best = 0;
    sc.forEach((v, i) => {
      if (v > sc[best]!) best = i;
    });
    s.winner = best;
    events.push({ kind: 'victory', realm: best, reason: 'last-winter', scores: sc });
  }
  return { state: s, events };
}

type Reject = (realm: number, order: Order, reason: string) => void;
type OrdersOf = (realm: number) => Order[];

/** Everyone trades at the posted price; the net flow moves next season's price. */
function trades(s: GameState, alive: number[], of: OrdersOf, reject: Reject, events: GameEvent[]): void {
  type Req = { realm: number; order: Extract<Order, { kind: 'trade' }> };
  const sells: Req[] = [];
  const buys: Req[] = [];
  for (const realm of alive)
    for (const o of of(realm)) {
      if (o.kind !== 'trade') continue;
      if (!GOODS.includes(o.good) || !isInt(o.qty) || o.qty <= 0 || (o.side !== 'buy' && o.side !== 'sell')) {
        reject(realm, o, 'malformed trade');
        continue;
      }
      (o.side === 'sell' ? sells : buys).push({ realm, order: o });
    }
  const flow = Object.fromEntries(GOODS.map((g) => [g, { sold: 0, bought: 0 }])) as Record<Good, { sold: number; bought: number }>;

  for (const { realm, order } of sells) {
    const purse = s.realms[realm]!.purse;
    const qty = Math.min(order.qty, purse[order.good]);
    if (qty <= 0) {
      reject(realm, order, `no ${order.good} to sell`);
      continue;
    }
    const price = sellPrice(s.market.price[order.good]);
    purse[order.good] -= qty;
    purse.crowns += qty * price;
    flow[order.good].sold += qty;
    events.push({ kind: 'trade', realm, good: order.good, side: 'sell', qty, price });
  }

  for (const g of GOODS) {
    const reqs = buys.filter((b) => b.order.good === g);
    const price = s.market.price[g];
    const wanted = reqs.reduce((n, r) => n + r.order.qty, 0);
    const available = s.market.stock[g] + flow[g].sold - 1;
    for (const { realm, order } of reqs) {
      const purse = s.realms[realm]!.purse;
      // if the market runs short, everyone gets the same share
      let qty = wanted > available ? Math.floor((order.qty * available) / wanted) : order.qty;
      qty = Math.min(qty, Math.floor(purse.crowns / price));
      if (qty <= 0) {
        reject(realm, order, wanted > available ? `market short of ${g}` : 'not enough crowns');
        continue;
      }
      purse.crowns -= qty * price;
      purse[g] += qty;
      flow[g].bought += qty;
      events.push({ kind: 'trade', realm, good: g, side: 'buy', qty, price });
    }
  }
  for (const g of GOODS) {
    moveStock(s.market, g, flow[g].sold, 'trade', `realms sold ${flow[g].sold}`);
    moveStock(s.market, g, -flow[g].bought, 'trade', `realms bought ${flow[g].bought}`);
  }
}

function builds(s: GameState, alive: number[], of: OrdersOf, reject: Reject, events: GameEvent[]): void {
  const P = s.map.provinces.length;
  for (const realm of alive) {
    const purse = s.realms[realm]!.purse;
    for (const o of of(realm)) {
      if (o.kind === 'trade' || o.kind === 'march') continue;
      if (!isInt(o.province) || o.province < 0 || o.province >= P) {
        reject(realm, o, 'no such province');
        continue;
      }
      if (s.owner[o.province] !== realm) {
        reject(realm, o, 'not your province');
        continue;
      }
      const p = o.province;
      switch (o.kind) {
        case 'fortify':
          if (s.forts[p]! >= MAX_FORT) reject(realm, o, 'fort is at full strength');
          else if (!canPay(purse, COST.fortify)) reject(realm, o, 'cannot afford a fort');
          else {
            pay(purse, COST.fortify);
            s.forts[p]! += 1;
            events.push({ kind: 'built', realm, province: p, what: 'fort' });
          }
          break;
        case 'levy':
          if (!canPay(purse, COST.levy)) reject(realm, o, 'cannot afford a levy');
          else {
            pay(purse, COST.levy);
            s.armies.push({ realm, province: p, levies: COST.levyTroops, regulars: 0, mercs: 0 });
            events.push({ kind: 'built', realm, province: p, what: 'levy', count: COST.levyTroops });
          }
          break;
        case 'recruit': {
          if (!s.towns[p]) {
            reject(realm, o, 'regulars train only in towns');
            break;
          }
          if (!isInt(o.count) || o.count <= 0) {
            reject(realm, o, 'malformed count');
            break;
          }
          let n = o.count;
          while (n > 0 && !canPay(purse, COST.regular, n)) n--;
          if (n === 0) reject(realm, o, 'cannot afford regulars');
          else {
            pay(purse, COST.regular, n);
            s.armies.push({ realm, province: p, levies: 0, regulars: n, mercs: 0 });
            events.push({ kind: 'built', realm, province: p, what: 'regulars', count: n });
          }
          break;
        }
        case 'build':
          if (s.towns[p]) reject(realm, o, 'already a town');
          else if (s.map.provinces[p]!.terrain === 'pass') reject(realm, o, 'no town can stand in a pass');
          else if (!canPay(purse, COST.town)) reject(realm, o, 'cannot afford a town');
          else {
            pay(purse, COST.town);
            s.towns[p] = true;
            events.push({ kind: 'built', realm, province: p, what: 'town' });
          }
          break;
      }
    }
  }
  normaliseArmies(s);
}

/** Marches, border clashes and battles. Returns the provinces fought over (they yield nothing). */
function movement(
  s: GameState,
  alive: number[],
  of: OrdersOf,
  reject: Reject,
  events: GameEvent[],
  rollSeed: string,
): Set<number> {
  const P = s.map.provinces.length;
  const startArmies = s.armies.map((a) => ({ ...a }));
  type Mover = { realm: number; from: number; to: number; troops: Troops };
  const movers: Mover[] = [];

  for (const realm of alive) {
    for (const o of of(realm)) {
      if (o.kind !== 'march') continue;
      if (!isInt(o.from) || !isInt(o.to) || o.from < 0 || o.from >= P || o.to < 0 || o.to >= P) {
        reject(realm, o, 'no such province');
        continue;
      }
      if (!s.map.provinces[o.from]!.neighbors.includes(o.to)) {
        reject(realm, o, 'not adjacent');
        continue;
      }
      const army = armyAt(s, realm, o.from);
      if (!army) {
        reject(realm, o, 'no army there');
        continue;
      }
      const want = { ...pickTroops(army), ...(o.troops ?? {}) };
      const troops: Troops = {
        levies: Math.max(0, Math.min(army.levies, Math.floor(want.levies))),
        regulars: Math.max(0, Math.min(army.regulars, Math.floor(want.regulars))),
        mercs: Math.max(0, Math.min(army.mercs, Math.floor(want.mercs))),
      };
      if (troopCount(troops) === 0) {
        reject(realm, o, 'no troops left to march');
        continue;
      }
      army.levies -= troops.levies;
      army.regulars -= troops.regulars;
      army.mercs -= troops.mercs;
      const same = movers.find((m) => m.realm === realm && m.from === o.from && m.to === o.to);
      if (same) same.troops = addTroops(same.troops, troops);
      else movers.push({ realm, from: o.from, to: o.to, troops });

      // marching on a peace partner's land, or on its army, breaks the peace
      const victims = new Set<number>();
      if (s.owner[o.to]! >= 0) victims.add(s.owner[o.to]!);
      for (const a of startArmies) if (a.province === o.to && a.realm >= 0) victims.add(a.realm);
      for (const v of victims) {
        if (v === realm || friendly(s, realm, v)) continue;
        const peace = treatyBetween(s, realm, v, 'peace');
        if (peace) {
          s.treaties = s.treaties.filter((t) => t !== peace);
          events.push({ kind: 'treaty-broken', realm, against: v, treaty: 'peace', province: o.to });
          s.betrayals.push({ by: realm, against: v, season: s.season });
        }
      }
    }
  }

  const contingents = new Map<number, Contingent[]>();
  const place = (p: number, c: Contingent): void => {
    const list = contingents.get(p) ?? [];
    list.push(c);
    contingents.set(p, list);
  };
  for (const a of s.armies) if (troopCount(a) > 0) place(a.province, { realm: a.realm, troops: pickTroops(a), from: null });

  // border clashes: hostile armies swapping provinces meet on the border
  const bounced = new Set<Mover>();
  const sorted = [...movers].sort((a, b) => Math.min(a.from, a.to) - Math.min(b.from, b.to) || a.from - b.from || a.realm - b.realm);
  for (const m of sorted) {
    if (bounced.has(m)) continue;
    const other = sorted.find(
      (x) => x !== m && !bounced.has(x) && x.from === m.to && x.to === m.from && !friendly(s, x.realm, m.realm),
    );
    if (!other) continue;
    const lo = Math.min(m.from, m.to);
    const hi = Math.max(m.from, m.to);
    const sides: BattleSide[] = [m, other].map((x) => ({ realm: x.realm, troops: x.troops, defending: false, outOfSupply: false }));
    const result = fight(s, m.from, sides, rollSeed, `border:${lo}-${hi}`);
    events.push({ kind: 'battle', province: m.to, sides: result.sides, winner: result.winner, border: [lo, hi] });
    for (const x of [m, other]) {
      x.troops = result.sides.find((sd) => sd.realm === x.realm)!.troopsAfter;
      if (x.realm !== result.winner) bounced.add(x);
    }
  }
  for (const m of movers) {
    if (troopCount(m.troops) === 0) continue;
    if (bounced.has(m)) place(m.from, { realm: m.realm, troops: m.troops, from: null });
    else {
      place(m.to, { realm: m.realm, troops: m.troops, from: m.from });
      events.push({ kind: 'moved', realm: m.realm, from: m.from, to: m.to, troops: m.troops });
    }
  }

  // battles in provinces
  const pillaged = new Set<number>();
  type Retreat = { realm: number; from: number; to: number | null; troops: Troops };
  const retreats: Retreat[] = [];
  for (const p of [...contingents.keys()].sort((a, b) => a - b)) {
    const here = contingents.get(p)!;
    const realms = [...new Set(here.map((c) => c.realm))].sort((a, b) => a - b);
    const hostile = realms.some((a) => realms.some((b) => !friendly(s, a, b)));
    if (!hostile) continue;
    const owner = s.owner[p]!;
    const sides: BattleSide[] = realms.map((realm) => ({
      realm,
      troops: here.filter((c) => c.realm === realm).reduce((t, c) => addTroops(t, c.troops), noTroops()),
      defending: realm === owner || (owner === -1 && realm === NEUTRAL),
      outOfSupply: realm !== NEUTRAL && owner !== realm && !s.map.provinces[p]!.neighbors.some((n) => s.owner[n] === realm),
    }));
    const result = fight(s, p, sides, rollSeed, `province:${p}`);
    // allies of the winner stand aside and lose nothing
    for (const sd of result.sides) if (sd.realm !== result.winner && friendly(s, sd.realm, result.winner)) sd.troopsAfter = { ...sd.troopsBefore };
    events.push({ kind: 'battle', province: p, sides: result.sides, winner: result.winner });
    pillaged.add(p);

    const stay: Contingent[] = [];
    for (const sd of result.sides) {
      if (troopCount(sd.troopsAfter) === 0) {
        events.push({ kind: 'destroyed', realm: sd.realm, province: p });
        continue;
      }
      if (friendly(s, sd.realm, result.winner)) {
        stay.push({ realm: sd.realm, troops: sd.troopsAfter, from: null });
        continue;
      }
      if (sd.realm === NEUTRAL) {
        events.push({ kind: 'destroyed', realm: sd.realm, province: p });
        continue;
      }
      const mine = here.filter((c) => c.realm === sd.realm);
      const held = mine.some((c) => c.from === null);
      let to: number | null;
      if (held) {
        // defenders fall back to a neighbouring province of their own
        to = s.map.provinces[p]!.neighbors.find((n) => s.owner[n] === sd.realm) ?? null;
      } else {
        const biggest = [...mine].sort((a, b) => strength(b.troops) - strength(a.troops) || a.from! - b.from!)[0]!;
        to = biggest.from;
      }
      retreats.push({ realm: sd.realm, from: p, to, troops: sd.troopsAfter });
    }
    contingents.set(p, stay);
  }

  s.armies = [];
  for (const [p, list] of contingents) for (const c of list) s.armies.push({ realm: c.realm, province: p, ...c.troops });
  normaliseArmies(s);
  for (const r of retreats) {
    const blocked = r.to === null || s.armies.some((a) => a.province === r.to && !friendly(s, a.realm, r.realm));
    if (blocked) events.push({ kind: 'destroyed', realm: r.realm, province: r.from });
    else {
      s.armies.push({ realm: r.realm, province: r.to!, ...r.troops });
      events.push({ kind: 'retreated', realm: r.realm, from: r.from, to: r.to! });
    }
  }
  normaliseArmies(s);
  return pillaged;
}

/** An army alone in a province takes it. Taking a capital topples its realm. */
function captures(s: GameState, events: GameEvent[]): void {
  for (let p = 0; p < s.owner.length; p++) {
    const owner = s.owner[p]!;
    const here = s.armies.filter((a) => a.province === p);
    if (here.length === 0) continue;
    if (here.some((a) => a.realm === owner || a.realm === NEUTRAL)) continue;
    const takers = here.filter((a) => owner === -1 || !friendly(s, a.realm, owner));
    if (takers.length === 0) continue;
    takers.sort((a, b) => strength(b) - strength(a) || a.realm - b.realm);
    const taker = takers[0]!.realm;
    s.owner[p] = taker;
    s.forts[p] = Math.max(0, s.forts[p]! - 1);
    events.push({ kind: 'captured', realm: taker, province: p, from: owner });
    const fallen = s.realms.find((r) => r.alive && r.id === owner && r.capital === p);
    if (fallen) {
      fallen.alive = false;
      const loot = Math.floor(fallen.purse.crowns / 2);
      s.realms[taker]!.purse.crowns += loot;
      fallen.purse.crowns -= loot;
      for (let q = 0; q < s.owner.length; q++) if (s.owner[q] === fallen.id) s.owner[q] = -1;
      s.armies = s.armies.filter((a) => a.realm !== fallen.id);
      s.treaties = s.treaties.filter((t) => !t.realms.includes(fallen.id));
      events.push({ kind: 'fallen', realm: fallen.id, by: taker });
    }
  }
}

function harvest(s: GameState, pillaged: Set<number>, events: GameEvent[]): void {
  const grainFactor = GRAIN_FACTOR[s.season % 4]!;
  const gains = new Map<number, Purse>();
  for (const r of s.realms) if (r.alive) gains.set(r.id, { crowns: 0, grain: 0, timber: 0, iron: 0, gold: 0 });
  const lost = { grain: 0, timber: 0, iron: 0, gold: 0 };
  s.map.provinces.forEach((prov, p) => {
    const y = prov.yields;
    if (pillaged.has(p)) {
      lost.grain += y.grain * grainFactor;
      lost.timber += y.timber;
      lost.iron += y.iron;
      lost.gold += y.gold;
      return;
    }
    const g = gains.get(s.owner[p]!);
    if (!g) return;
    g.grain += y.grain * grainFactor;
    g.timber += y.timber;
    g.iron += y.iron;
    g.gold += y.gold;
    if (s.towns[p]) g.crowns += s.realms[s.owner[p]!]!.capital === p ? CAPITAL_CROWNS : TOWN_CROWNS;
  });
  for (const [realm, g] of gains) {
    const purse = s.realms[realm]!.purse;
    for (const k of Object.keys(g) as (keyof Purse)[]) purse[k] += g[k];
    events.push({ kind: 'harvest', realm, gained: g });
  }
  // tribute: realms[0] pays realms[1] each season, as far as its treasury allows
  for (const t of s.treaties) {
    if (t.kind !== 'tribute' || !t.amount) continue;
    const [from, to] = t.realms;
    const payer = s.realms[from]!;
    const amount = Math.min(t.amount, payer.purse.crowns);
    if (!payer.alive || !s.realms[to]!.alive || amount <= 0) continue;
    payer.purse.crowns -= amount;
    s.realms[to]!.purse.crowns += amount;
    events.push({ kind: 'tribute', from, to, amount });
  }
  // fighting spoils the harvest everywhere: lost output is missing from the market
  for (const g of GOODS) moveStock(s.market, g, -lost[g], 'war', `fighting spoiled ${lost[g]} ${g}`);
  if (grainFactor === 2) moveStock(s.market, 'grain', 20, 'harvest', 'autumn harvest gluts the grain market');
  if (grainFactor === 0) moveStock(s.market, 'grain', -20, 'harvest', 'winter empties the granaries');
}

/**
 * Stores above the limit spoil; armies eat grain and regulars and mercenaries draw pay;
 * the unfed and unpaid desert.
 */
function upkeep(s: GameState, events: GameEvent[]): void {
  for (const realm of s.realms) {
    if (!realm.alive) continue;
    const mine = s.armies.filter((a) => a.realm === realm.id);
    const purse = realm.purse;
    const spoiled = { grain: 0, timber: 0, iron: 0, gold: 0 };
    for (const g of ['grain', 'timber', 'iron'] as const) {
      const excess = purse[g] - STORE_LIMIT;
      if (excess > 0) {
        spoiled[g] = Math.ceil((excess * SPOIL_PCT) / 100);
        purse[g] -= spoiled[g];
      }
    }
    const paid: Purse = { crowns: 0, grain: 0, timber: 0, iron: 0, gold: 0 };
    const deserted = noTroops();
    const desert = (kind: keyof Troops): boolean => {
      const a = mine.find((x) => x[kind] > 0);
      if (!a) return false;
      a[kind] -= 1;
      deserted[kind] += 1;
      return true;
    };

    const total = (): number => mine.reduce((n, a) => n + troopCount(a), 0);
    const fed = purse.grain * TROOPS_PER_GRAIN;
    while (total() > fed && (desert('levies') || desert('regulars') || desert('mercs')));
    const grainNeed = Math.ceil(total() / TROOPS_PER_GRAIN);
    purse.grain -= grainNeed;
    paid.grain = grainNeed;

    const wages = (): number => mine.reduce((n, a) => n + a.regulars * UPKEEP.regulars + a.mercs * UPKEEP.mercs, 0);
    while (wages() > purse.crowns && (desert('mercs') || desert('regulars')));
    paid.crowns = wages();
    purse.crowns -= paid.crowns;
    events.push({ kind: 'upkeep', realm: realm.id, paid, deserted, spoiled });
  }
  normaliseArmies(s);
}
