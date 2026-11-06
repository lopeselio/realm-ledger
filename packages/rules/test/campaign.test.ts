import { describe, expect, it } from 'vitest';
import {
  aiOrders,
  canonicalJson,
  commit,
  decideOrders,
  newCampaign,
  newSalt,
  resolveSeason,
  runCampaign,
  sealOrders,
  stateHash,
  verifySeal,
  viewFor,
  visibleProvinces,
} from '../src/index.ts';

describe('seals', () => {
  const orders = { realm: 2, season: 5, orders: [{ kind: 'march' as const, from: 1, to: 2 }] };

  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it('verifies the revealed orders and rejects any change', () => {
    const salt = newSalt();
    const seal = sealOrders(orders, salt);
    expect(seal).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySeal(seal, orders, salt)).toBe(true);
    expect(verifySeal(seal, { ...orders, orders: [{ kind: 'march', from: 1, to: 3 }] }, salt)).toBe(false);
    expect(verifySeal(seal, orders, newSalt())).toBe(false);
  });

  it('matches a sha256 computed outside the code', () => {
    // printf '1|x' | shasum -a 256
    expect(commit(1, 'x')).toBe('325d428644d27f23404f0104c378605b7db7b8f6ead9f5285dc46747945657b6');
  });
});

describe('AI campaigns', () => {
  it('replay identically from the seed (determinism)', () => {
    const a = runCampaign({ seed: 'replay', realms: 4 });
    const b = runCampaign({ seed: 'replay', realms: 4 });
    expect(stateHash(a.state)).toBe(stateHash(b.state));
    expect(a.history.length).toBe(b.history.length);
  });

  it('can be re-resolved season by season from the recorded orders', () => {
    const { state, history } = runCampaign({ seed: 'verify-me', realms: 5 });
    let s = newCampaign({ seed: 'verify-me', realms: 5, human: null });
    for (const h of history) s = resolveSeason(s, h.orders, { rollSeed: h.rollSeed }).state;
    expect(stateHash(s)).toBe(stateHash(state));
  });

  it('ends with a winner and never issues malformed orders', () => {
    for (let i = 0; i < 20; i++) {
      const { state, history } = runCampaign({ seed: `ai-${i}` });
      expect(state.winner).not.toBeNull();
      const reasons = history.flatMap((h) => h.events).flatMap((e) => (e.kind === 'rejected' ? [e.reason] : []));
      // the only acceptable refusal is a market that sold out to other realms first
      expect(reasons.filter((r) => !r.startsWith('market short'))).toEqual([]);
    }
  });

  it('decides only from its own view', () => {
    const s = newCampaign({ seed: 'fog' });
    const me = 0;
    const view = viewFor(s, me);
    expect(view.realms[1]!.purse.crowns).toBe(0);
    expect(decideOrders(view, me)).toEqual(decideOrders(viewFor(s, me), me));
    // a hidden army growing elsewhere doesn't change the decision
    const seen = visibleProvinces(s, me);
    const s2 = structuredClone(s);
    const hidden = s2.armies.find((a) => !seen.has(a.province));
    expect(hidden).toBeDefined();
    hidden!.regulars += 50;
    expect(decideOrders(viewFor(s2, me), me)).toEqual(decideOrders(view, me));
  });

  it('gives every living AI realm an order set', () => {
    const s = newCampaign({ seed: 'orders', human: 1 });
    const sets = aiOrders(s);
    expect(sets.map((x) => x.realm)).toEqual(s.realms.filter((r) => !r.human).map((r) => r.id));
  });
});
