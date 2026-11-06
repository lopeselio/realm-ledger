import { defenceBonus } from './battle.ts';
import { BASE_PRICE, COST, GRAIN_FACTOR, MAX_FORT, NEUTRAL, STORE_LIMIT, TROOPS_PER_GRAIN, UPKEEP } from './constants.ts';
import { sellPrice } from './market.ts';
import { friendly, strength, treatyBetween, troopCount } from './state.ts';
import { GOODS, type Army, type GameState, type Good, type Order, type Purse } from './types.ts';

/** Goods an AI keeps in reserve before selling the rest. */
const RESERVE: Record<Exclude<Good, 'grain'>, number> = { timber: 8, iron: 6, gold: 0 };

/**
 * The deterministic strategy engine for an AI ruler. It decides from the realm's own
 * view (fog of war applied) and its personality and agenda. Same view, same orders.
 * The language model never calls this with anything but a view; it only voices the result.
 */
export function decideOrders(view: GameState, me: number): Order[] {
  const realm = view.realms[me];
  if (!realm || !realm.alive) return [];
  const { greed, caution, honour, ambition } = realm.personality;
  const orders: Order[] = [];
  const purse: Purse = { ...realm.purse };
  const map = view.map;
  const P = map.provinces.length;

  const hostile = (other: number): boolean => other !== me && !friendly(view, me, other);
  const mine = view.armies.filter((a) => a.realm === me);
  const ownStrength = new Array<number>(P).fill(0);
  for (const a of mine) ownStrength[a.province]! += strength(a);
  const enemyAt = new Array<number>(P).fill(0);
  for (const a of view.armies) if (hostile(a.realm)) enemyAt[a.province]! += strength(a);
  /** hostile strength that could reach each province next season */
  const threat = new Array<number>(P).fill(0);
  for (let p = 0; p < P; p++) {
    threat[p] = enemyAt[p]!;
    for (const n of map.provinces[p]!.neighbors) {
      // militias never march, so they threaten nobody
      threat[p]! += view.armies.filter((a) => a.province === n && hostile(a.realm) && a.realm !== NEUTRAL).reduce((s, a) => s + strength(a), 0);
    }
  }
  const owned = view.owner.map((o, p) => (o === me ? p : -1)).filter((p) => p >= 0);
  const capitalOf = new Map(view.realms.filter((x) => x.alive).map((x) => [x.capital, x.id]));

  // ---- economy ----
  const troops = mine.reduce((n, a) => n + troopCount(a), 0);
  const grainIncome = owned.reduce((n, p) => n + map.provinces[p]!.yields.grain, 0) * GRAIN_FACTOR[view.season % 4]!;
  const grainNeed = Math.ceil(troops / TROOPS_PER_GRAIN);
  const wages = mine.reduce((n, a) => n + a.regulars * UPKEEP.regulars + a.mercs * UPKEEP.mercs, 0);
  const hoard = realm.agenda.kind === 'hoard' ? realm.agenda.good : undefined;

  for (const g of GOODS) {
    if (g === 'grain' || g === hoard) continue;
    const surplus = purse[g] - RESERVE[g];
    // greedy rulers wait for a good price
    const priceOk = view.market.price[g] * 10 >= BASE_PRICE[g] * (5 + greed / 2);
    // but nobody lets a big pile spoil
    if (surplus > 0 && (priceOk || purse[g] > STORE_LIMIT - 10)) {
      orders.push({ kind: 'trade', good: g, side: 'sell', qty: surplus });
      purse[g] -= surplus;
      purse.crowns += surplus * sellPrice(view.market.price[g]);
    }
  }
  // keep one season of grain in hand after this season's upkeep, plus a winter store
  const winterAhead = view.season % 4 >= 1 ? grainNeed : 0;
  const grainShort = grainNeed * 2 + winterAhead - (purse.grain + grainIncome);
  if (grainShort > 0) {
    const qty = Math.min(grainShort, Math.floor((purse.crowns - wages) / view.market.price.grain));
    if (qty > 0) {
      orders.push({ kind: 'trade', good: 'grain', side: 'buy', qty });
      purse.grain += qty;
      purse.crowns -= qty * view.market.price.grain;
    }
  } else if (hoard !== 'grain' && -grainShort > grainNeed * 3 + 6 && (greed >= 6 || purse.grain > STORE_LIMIT - 10)) {
    // only sell what is already in the barn, not the harvest still to come
    const qty = Math.min(purse.grain, -grainShort - grainNeed * 3);
    if (qty > 0) {
      orders.push({ kind: 'trade', good: 'grain', side: 'sell', qty });
      purse.grain -= qty;
      purse.crowns += qty * sellPrice(view.market.price.grain);
    }
  }
  if (hoard && hoard !== 'grain' && purse.crowns > wages * 3 + 30 && view.market.price[hoard] <= BASE_PRICE[hoard]) {
    orders.push({ kind: 'trade', good: hoard, side: 'buy', qty: 2 });
    purse.crowns -= 2 * view.market.price[hoard];
    purse[hoard] += 2;
  }

  const reserve = wages * 2 + 4;
  const spendable = (): number => purse.crowns - reserve;

  // ---- builds ----
  const byThreat = [...owned].sort((a, b) => threat[b]! - ownStrength[b]! - (threat[a]! - ownStrength[a]!) || a - b);
  const worst = byThreat[0];
  if (
    worst !== undefined &&
    caution >= 4 &&
    threat[worst]! > ownStrength[worst]! / 2 &&
    view.forts[worst]! < Math.min(MAX_FORT, caution >= 7 ? 3 : 2) &&
    purse.timber >= COST.fortify.timber &&
    purse.iron >= COST.fortify.iron &&
    spendable() >= COST.fortify.crowns
  ) {
    orders.push({ kind: 'fortify', province: worst });
    purse.timber -= COST.fortify.timber;
    purse.iron -= COST.fortify.iron;
    purse.crowns -= COST.fortify.crowns;
  }

  const towns = owned.filter((p) => view.towns[p]);
  const danger = worst !== undefined ? threat[worst]! - ownStrength[worst]! : 0;
  const drive = (ambition + caution + (danger > 0 ? 6 : 0)) / 26;
  let recruits = Math.floor((spendable() * drive) / COST.regular.crowns);
  if (recruits > purse.iron) {
    // buy the iron to arm them
    const perHead = COST.regular.crowns + view.market.price.iron;
    recruits = Math.max(purse.iron, Math.floor((spendable() * drive) / perHead));
    const buy = Math.min(recruits - purse.iron, Math.floor(view.market.stock.iron / 2));
    if (buy > 0) {
      orders.push({ kind: 'trade', good: 'iron', side: 'buy', qty: buy });
      purse.iron += buy;
      purse.crowns -= buy * view.market.price.iron;
    }
    recruits = Math.min(recruits, purse.iron);
  }
  if (recruits > 0 && towns.length > 0) {
    // train where the danger is, else at the capital
    const where = [...towns].sort((a, b) => threat[b]! - threat[a]! || Number(b === realm.capital) - Number(a === realm.capital) || a - b)[0]!;
    orders.push({ kind: 'recruit', province: where, count: recruits });
    purse.crowns -= recruits * COST.regular.crowns;
    purse.iron -= recruits * COST.regular.iron;
    ownStrength[where]! += recruits * 3;
  }
  if (worst !== undefined && threat[worst]! > ownStrength[worst]! && purse.crowns >= COST.levy.crowns && purse.grain >= COST.levy.grain + grainNeed) {
    orders.push({ kind: 'levy', province: worst });
    purse.crowns -= COST.levy.crowns;
    purse.grain -= COST.levy.grain;
    ownStrength[worst]! += COST.levyTroops;
  }
  if (greed >= 6 && spendable() >= COST.town.crowns + 10 && purse.timber >= COST.town.timber) {
    const site = owned
      .filter((p) => !view.towns[p] && map.provinces[p]!.terrain !== 'pass' && threat[p] === 0)
      .sort((a, b) => worth(view, b) - worth(view, a) || a - b)[0];
    if (site !== undefined) {
      orders.push({ kind: 'build', province: site });
      purse.crowns -= COST.town.crowns;
      purse.timber -= COST.town.timber;
    }
  }

  // ---- armies ----
  const committed = new Array<number>(P).fill(0);
  for (const army of [...mine].sort((a, b) => a.province - b.province)) {
    const move = chooseMove(view, me, army, { threat, ownStrength, enemyAt, committed, capitalOf, caution, honour, ambition, hostile });
    if (!move) continue;
    orders.push(move.order);
    committed[move.order.to]! += move.strength;
    ownStrength[army.province]! -= move.strength;
  }
  return orders;
}

function worth(view: GameState, p: number): number {
  const y = view.map.provinces[p]!.yields;
  return y.grain + y.timber + y.iron + 2 * y.gold + (view.towns[p] ? 6 : 0);
}

interface MoveCtx {
  threat: number[];
  ownStrength: number[];
  enemyAt: number[];
  committed: number[];
  capitalOf: Map<number, number>;
  caution: number;
  honour: number;
  ambition: number;
  hostile: (realm: number) => boolean;
}

function chooseMove(
  view: GameState,
  me: number,
  army: Army,
  ctx: MoveCtx,
): { order: Extract<Order, { kind: 'march' }>; strength: number } | null {
  const realm = view.realms[me]!;
  const here = army.province;
  const map = view.map;
  const isCapital = here === realm.capital;

  // what has to stay behind
  const keep = { levies: 0, regulars: 0, mercs: 0 };
  if (isCapital) keep.levies = Math.min(army.levies, 3);
  if (view.owner[here] === me && ctx.threat[here]! > 0) {
    const hold = ctx.threat[here]! * (0.5 + ctx.caution / 10) - (ctx.ownStrength[here]! - strength(army));
    if (hold >= strength(army) * 0.8) return null;
    if (hold > 0) {
      keep.levies = army.levies;
      keep.regulars = Math.min(army.regulars, Math.ceil(Math.max(0, hold - army.levies) / 3));
    }
  }
  const troops = { levies: army.levies - keep.levies, regulars: army.regulars - keep.regulars, mercs: army.mercs - keep.mercs };
  const mobile = strength(troops);
  if (mobile <= 0) return null;

  let best: { to: number; score: number } | null = null;
  const consider = (to: number, score: number): void => {
    if (score > 0 && (!best || score > best.score)) best = { to, score };
  };
  const agenda = realm.agenda;

  for (const n of map.provinces[here]!.neighbors) {
    const owner = view.owner[n]!;
    if (owner === me || (owner >= 0 && !ctx.hostile(owner))) {
      // reinforce a threatened province of ours
      if (owner === me) {
        const gap = ctx.threat[n]! - ctx.ownStrength[n]! - ctx.committed[n]!;
        if (gap > 0 && ctx.threat[here]! === 0) consider(n, gap * ctx.caution);
      }
      continue;
    }
    const peace = owner >= 0 && treatyBetween(view, me, owner, 'peace');
    if (peace && ctx.honour >= 6) continue;
    const defence = ctx.enemyAt[n]! * (10 + defenceBonus(view, n));
    const attack = (mobile + ctx.committed[n]!) * 10;
    const needed = 1 + ctx.caution / 10;
    if (defence > 0 && attack < defence * needed) continue;
    let value = 10 + worth(view, n) * 2;
    if (ctx.capitalOf.has(n)) value += 40;
    if (agenda.kind === 'covet' && agenda.provinces?.includes(n)) value += 20;
    if (agenda.kind === 'vendetta' && owner === agenda.realm) value += 15;
    if (peace) value -= ctx.honour * 4;
    value *= 0.5 + ctx.ambition / 10;
    consider(n, value);
  }

  if (!best) {
    // nothing to do here: walk toward the nearest land that isn't ours
    const step = stepToward(view, me, here);
    if (step !== null && mobile >= 4) consider(step, 1);
  }
  if (!best) return null;
  const { to } = best as { to: number; score: number };
  const order: Extract<Order, { kind: 'march' }> = { kind: 'march', from: here, to };
  if (keep.levies + keep.regulars + keep.mercs > 0) order.troops = troops;
  return { order, strength: mobile };
}

/** First step of a shortest path through our own land to a province we don't hold. */
function stepToward(view: GameState, me: number, from: number): number | null {
  const prev = new Map<number, number>([[from, -1]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    if (view.owner[p] !== me) {
      let step = p;
      while (prev.get(step) !== from && prev.get(step) !== -1) step = prev.get(step)!;
      // only walk through our own land; attacks are chosen above
      return step === from || view.owner[step] !== me ? null : step;
    }
    for (const n of view.map.provinces[p]!.neighbors) {
      if (!prev.has(n)) {
        prev.set(n, p);
        queue.push(n);
      }
    }
  }
  return null;
}
