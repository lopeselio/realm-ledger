import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aiOrders,
  canonicalJson,
  commit,
  newCampaign,
  replaySeason,
  sealOrders,
  seasonRollSeed,
  sha256Hex,
  stateHash,
  type GameState,
} from '@realm-ledger/rules';
import { describe, expect, it } from 'vitest';
import { checkReply, recoverSigner, rulesVersionOf, verifyBundle, type ProofBundle, type SignedReply } from '../src/index.ts';
import { QUICK_MAP } from '@realm-ledger/rules';

const fx = (f: string): string => readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8');

// A real reply from NEAR AI Cloud's TEE-hosted Qwen model, captured 2026-11-06.
const sig = JSON.parse(fx('signature.json')) as { text: string; signature: string; signing_address: string; signature_kind: string };
const reply: SignedReply = {
  realm: 1,
  season: 0,
  model: 'Qwen/Qwen3.6-35B-A3B-FP8',
  request: fx('request.json'),
  response: fx('response.json'),
  text: sig.text,
  signature: sig.signature,
  signingAddress: sig.signing_address,
  signatureKind: sig.signature_kind,
};

describe('TEE reply signatures', () => {
  it('recover the attested signing address from a real reply', () => {
    expect(recoverSigner(reply.text, reply.signature)).toBe('0xfdbd7952498b333206f360d71d97a1e0961e8ddf');
    expect(checkReply(reply).ok).toBe(true);
  });

  it('fail when a single byte of the response changes', () => {
    const tampered = { ...reply, response: reply.response.replace('"assistant"', '"Assistant"') };
    expect(tampered.response).not.toBe(reply.response);
    expect(checkReply(tampered).ok).toBe(false);
  });

  it('fail when the claimed signer is someone else', () => {
    expect(checkReply({ ...reply, signingAddress: '0x0000000000000000000000000000000000000001' }).ok).toBe(false);
  });
});

/** Plays a short AI campaign the way the server does and builds its bundle. */
function bundleFor(seed: string, seasons: number): ProofBundle {
  const options = { seed, realms: 3, human: null, maxSeasons: seasons, rulesVersion: 2 };
  let s: GameState = newCampaign(options);
  const rollSecret = 'roll-secret';
  const rollSalt = 'rs';
  const agendaSalts = s.realms.map((_, i) => `as-${i}`);
  const b: ProofBundle = {
    version: 1,
    contract: 'realm-ledger.testnet',
    campaign: 0,
    options,
    rollCommit: commit(rollSecret, rollSalt),
    agendaCommits: s.realms.map((r, i) => commit(r.agenda, agendaSalts[i]!)),
    rollSecret,
    rollSalt,
    agendaSalts,
    seasons: [],
    replies: [reply],
    attestation: { nonce: 'n', model: reply.model, report: { model_attestations: [{ signing_address: reply.signingAddress }] } },
  };
  for (let i = 0; i < seasons; i++) {
    const orders = aiOrders(s);
    const rollSeed = seasonRollSeed(rollSecret, s.season);
    const seals = orders.map((o) => ({ realm: o.realm, salt: `salt-${i}-${o.realm}`, orders: o, seal: sealOrders(o, `salt-${i}-${o.realm}`) }));
    s = replaySeason(s, { season: s.season, treaties: [], deals: [], orders, rollSeed, events: [] }).state;
    b.seasons.push({ season: i, treaties: [], seals, rollSeed, stateHash: stateHash(s) });
  }
  return b;
}

describe('campaigns from before the agent market (rules version 1)', () => {
  it('a real finished campaign recorded on testnet still verifies', () => {
    const old = JSON.parse(fx('campaign-11-v1.json')) as ProofBundle;
    expect(old.options.rulesVersion).toBeUndefined();
    const checks = verifyBundle(old);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.filter((c) => c.name.includes('replay reaches the recorded state'))).toHaveLength(4);
  });

  it('would not verify if replayed under the current rules', () => {
    const old = JSON.parse(fx('campaign-11-v1.json')) as ProofBundle;
    const checks = verifyBundle({ ...old, options: { ...old.options, rulesVersion: 2 } });
    expect(checks.some((c) => !c.ok && c.name.includes('replay'))).toBe(true);
  });
});

describe('verifyBundle', () => {
  it('passes an honest campaign', () => {
    const checks = verifyBundle(bundleFor('verify', 4));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.length).toBeGreaterThan(10);
  });

  it('catches orders changed after sealing', () => {
    const b = bundleFor('verify', 3);
    const x = b.seasons[1]!.seals[0]!;
    x.orders = { ...x.orders, orders: [] };
    const failed = verifyBundle(b).filter((c) => !c.ok).map((c) => c.name);
    expect(failed.some((n) => n.includes('match their seals'))).toBe(true);
  });

  it('catches a changed battle roll', () => {
    const b = bundleFor('verify', 3);
    b.seasons[0]!.rollSeed = 'different';
    expect(verifyBundle(b).some((c) => !c.ok && c.name.includes('roll seed'))).toBe(true);
  });

  it('catches a lied-about agenda', () => {
    const b = bundleFor('verify', 1);
    b.agendaSalts![0] = 'wrong';
    expect(verifyBundle(b).some((c) => !c.ok && c.name.includes('agenda'))).toBe(true);
  });

  it('catches a Chancellor that paid a spy for a false report', () => {
    const b = bundleFor('verify', 2);
    const province = 0;
    const lie = { company: 2, province, season: 0, armies: [{ realm: 1, troops: 99 }] };
    const job = {
      job: 0,
      season: 0,
      deal: { kind: 'spy' as const, realm: 0, company: 2, province, price: 10 },
      buyer: 'chancellor',
      worker: 'spy0',
      payload: lie,
      delivery: sha256Hex(canonicalJson(lie)),
      passed: true,
    };
    b.jobs = [job];
    expect(verifyBundle(b).some((c) => !c.ok && c.name.includes('paid only if the report matched'))).toBe(true);
    b.jobs = [{ ...job, passed: false }];
    expect(verifyBundle(b).filter((c) => !c.ok)).toEqual([]);
  });

  it('catches a reply signed by a key the attestation does not vouch for', () => {
    const b = bundleFor('verify', 1);
    b.attestation!.report.model_attestations = [{ signing_address: '0x0000000000000000000000000000000000000002' }];
    expect(verifyBundle(b).some((c) => !c.ok && c.name.includes('attested TEE key'))).toBe(true);
  });
});

describe('rules version of a bundle', () => {
  const bundle = (seasons: object[], rulesVersion?: number) =>
    ({ options: { seed: 's', realms: 3, human: 0, maxSeasons: 4, ...(rulesVersion ? { rulesVersion } : {}) }, seasons }) as unknown as ProofBundle;

  it('is version 1 for a campaign from before the agent market, even after a newer server settles more seasons', () => {
    expect(rulesVersionOf(bundle([{ season: 0 }, { season: 1 }]))).toBe(1);
    expect(rulesVersionOf(bundle([{ season: 0 }, { season: 1, deals: [] }]))).toBe(1);
  });

  it('is version 2 when the first season carries deals, and whatever the bundle says when it says', () => {
    expect(rulesVersionOf(bundle([{ season: 0, deals: [] }]))).toBe(2);
    expect(rulesVersionOf(bundle([{ season: 0 }], 2))).toBe(2);
  });
});

describe('the map a bundle claims', () => {
  const opts = (seed: string, map?: object) => ({ options: { seed, realms: 3, human: 0, maxSeasons: 6, rulesVersion: 2, ...(map !== undefined ? { map } : {}) }, seasons: [], replies: [] }) as unknown as ProofBundle;
  const mapCheck = (b: ProofBundle) => verifyBundle(b).find((c) => c.name === 'map size matches the seed');

  it('takes the standard map, and the quick map with a quick seed', () => {
    expect(mapCheck(opts('rl-abc'))?.ok).toBe(true);
    expect(mapCheck(opts('rl-abc-q', { ...QUICK_MAP }))?.ok).toBe(true);
  });

  it('refuses a map the seed does not name, or one of any other size, before building it', () => {
    expect(mapCheck(opts('rl-abc', { ...QUICK_MAP }))?.ok).toBe(false);
    expect(mapCheck(opts('rl-abc-q'))?.ok).toBe(false);
    const huge = verifyBundle(opts('rl-abc-q', { radius: 100000 }));
    expect(huge).toHaveLength(1);
    expect(huge[0]!.ok).toBe(false);
    // a JSON null, or a quick seed on another shape, is refused the same way
    expect(verifyBundle(opts('rl-abc-q', null as unknown as object))[0]!.ok).toBe(false);
    const big = opts('rl-abc-q', { ...QUICK_MAP });
    big.options.realms = 6;
    expect(mapCheck(big)?.ok).toBe(false);
  });
});

describe('a malformed bundle', () => {
  it('is reported, not crashed on', () => {
    const b = { options: { realms: 3, human: 0, maxSeasons: 6 }, seasons: [], replies: [] } as unknown as ProofBundle;
    expect(verifyBundle(b)[0]).toMatchObject({ name: 'map size matches the seed', ok: false });
  });
});

