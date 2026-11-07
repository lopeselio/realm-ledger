// Checks a Realm Ledger campaign proof bundle. Needs no API key and trusts nobody:
// every claim is recomputed from the bundle (and, optionally, read back from the chain).

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  canonicalJson,
  commit,
  newCampaign,
  replaySeason,
  sealOrders,
  seasonRollSeed,
  sha256Hex,
  stateHash,
  reportHolds,
  type Agenda,
  type Deal,
  type GameState,
  type SpyReport,
  type OrderSet,
  type Treaty,
} from '@realm-ledger/rules';

/** One reply from the TEE model, with everything needed to check its signature. */
export interface SignedReply {
  realm: number;
  season: number;
  model: string;
  /** the exact request body bytes sent, as UTF-8 text */
  request: string;
  /** the exact response body bytes received, as UTF-8 text */
  response: string;
  /** what the TEE signed: `<model>:<sha256(request)>:<sha256(response)>` */
  text: string;
  signature: string;
  signingAddress: string;
  signatureKind: string;
}

/** A hire through the contract's escrow, with what was delivered and the buyer's verdict. */
export interface MarketJob {
  /** onchain job id */
  job: number;
  season: number;
  deal: Extract<Deal, { kind: 'mercs' | 'spy' }>;
  buyer: string;
  worker: string;
  /** what the worker delivered: a spy's report, or the muster of swords */
  payload: SpyReport | { province: number; count: number; season: number };
  /** sha256(canonical payload), posted onchain by the worker */
  delivery: string;
  passed: boolean;
}

export interface SeasonProof {
  season: number;
  treaties: Treaty[];
  /** market purchases applied before the season resolved */
  deals?: Deal[];
  /** one per realm that sealed and revealed */
  seals: { realm: number; seal: string; salt: string; orders: OrderSet }[];
  /**
   * realms that sealed but never revealed: the referee settled without their orders once the
   * contract allowed it (a full season after seals closed), so they did nothing that season
   */
  forfeited?: number[];
  rollSeed: string;
  /** stateHash after the season resolved */
  stateHash: string;
}

export interface ProofBundle {
  version: 1;
  contract: string;
  campaign: number;
  /** rulesVersion is absent in bundles from before the agent market, which play by version 1 */
  options: { seed: string; realms: number; human: number | null; maxSeasons: number; rulesVersion?: number };
  rollCommit: string;
  agendaCommits: string[];
  /** revealed when the campaign ends */
  rollSecret?: string;
  rollSalt?: string;
  agendaSalts?: string[];
  seasons: SeasonProof[];
  replies: SignedReply[];
  jobs?: MarketJob[];
  /** the model attestation report fetched at campaign start, with the nonce we sent */
  attestation?: { nonce: string; model: string; report: { model_attestations?: { signing_address?: string }[] } };
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Recovers the Ethereum-style address that signed `text` (EIP-191 personal_sign). */
export function recoverSigner(text: string, signatureHex: string): string {
  const sig = hexToBytes(signatureHex.replace(/^0x/, ''));
  if (sig.length !== 65) throw new Error('signature must be 65 bytes');
  const msg = utf8ToBytes(text);
  const hash = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
  const pub = secp256k1.recoverPublicKey(new Uint8Array([v, ...sig.slice(0, 64)]), hash, { prehash: false });
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20))}`;
}

/** Checks one TEE reply: the hashes match the bytes, and the signature recovers the signing address. */
export function checkReply(r: SignedReply): Check {
  const name = `reply to realm ${r.realm}, season ${r.season}`;
  const expected = `${r.model}:${sha256Hex(r.request)}:${sha256Hex(r.response)}`;
  if (r.text !== expected) return { name, ok: false, detail: 'signed text does not match the request and response bytes' };
  let signer: string;
  try {
    signer = recoverSigner(r.text, r.signature);
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message };
  }
  if (signer.toLowerCase() !== r.signingAddress.toLowerCase()) return { name, ok: false, detail: `signed by ${signer}, not ${r.signingAddress}` };
  return { name, ok: true, detail: `signed by ${signer}` };
}

/**
 * Verifies a bundle. Returns every check; the campaign is proven only if all pass.
 * What this does not do: verify the Intel TDX / NVIDIA quotes inside the attestation
 * report (that needs Intel's DCAP collateral); it checks that the signing address the
 * replies recover to is the one the attestation report binds to the TEE.
 */
export function verifyBundle(b: ProofBundle): Check[] {
  const checks: Check[] = [];
  const push = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  };

  let state: GameState = newCampaign({ ...b.options, rulesVersion: rulesVersionOf(b) });
  const after = new Map<number, GameState>();
  push('campaign rebuilt from its seed', true, `${state.map.provinces.length} provinces, ${state.realms.length} realms`);

  // commitments made at campaign start
  if (b.rollSecret !== undefined && b.rollSalt !== undefined) {
    push('roll secret matches its commitment', commit(b.rollSecret, b.rollSalt) === b.rollCommit);
  } else push('roll secret revealed', false, 'campaign not finished: roll secret not revealed yet');
  if (b.agendaSalts) {
    const ok = state.realms.every((r, i) => commit(r.agenda as Agenda, b.agendaSalts![i]!) === b.agendaCommits[i]);
    push('every agenda matches its commitment', ok);
  }

  for (const sp of b.seasons) {
    if (b.rollSecret !== undefined) push(`season ${sp.season}: roll seed derives from the secret`, seasonRollSeed(b.rollSecret, sp.season) === sp.rollSeed);
    const sealsOk = sp.seals.every((x) => x.orders.realm === x.realm && x.orders.season === sp.season && sealOrders(x.orders, x.salt) === x.seal);
    push(`season ${sp.season}: ${sp.seals.length} reveals match their seals`, sealsOk);
    // the onchain check below confirms each forfeited realm sealed and never revealed
    for (const r of sp.forfeited ?? []) push(`season ${sp.season}: realm ${r} is listed as forfeited and has no reveal`, !sp.seals.some((x) => x.realm === r));
    const result = replaySeason(state, {
      season: sp.season,
      treaties: sp.treaties,
      deals: sp.deals ?? [],
      orders: sp.seals.map((x) => x.orders),
      rollSeed: sp.rollSeed,
      events: [],
    });
    state = result.state;
    after.set(sp.season, state);
    const h = stateHash(state);
    push(`season ${sp.season}: replay reaches the recorded state`, h === sp.stateHash, h === sp.stateHash ? undefined : `got ${h}`);
  }

  for (const j of b.jobs ?? []) {
    const name = `job ${j.job} (${j.deal.kind}, season ${j.season})`;
    push(`${name}: delivery hash matches what was delivered`, sha256Hex(canonicalJson(j.payload)) === j.delivery);
    const end = after.get(j.season);
    if (!end) {
      push(`${name}: season replayed`, false, 'season not in the bundle');
      continue;
    }
    if (j.deal.kind === 'spy') {
      const holds = reportHolds(end, j.payload as SpyReport);
      push(`${name}: paid only if the report matched the truth`, holds === j.passed, holds ? 'report true' : 'report false');
    } else {
      const ok = j.passed && (j.payload as { count: number }).count === j.deal.count;
      push(`${name}: swords mustered as hired`, ok);
    }
  }

  const attested = new Set(
    (b.attestation?.report.model_attestations ?? []).map((m) => (m.signing_address ?? '').toLowerCase()).filter(Boolean),
  );
  for (const r of b.replies) {
    const c = checkReply(r);
    checks.push(c);
    if (c.ok && b.attestation) {
      push(`${c.name}: signer is the attested TEE key`, attested.has(r.signingAddress.toLowerCase()));
    }
  }
  return checks;
}

/**
 * Which rules a bundle plays by. Bundles from before the agent market carry no version
 * and no market deals (version 1); bundles from the first market servers carry deals but
 * no version (version 2); newer ones say so.
 */
export function rulesVersionOf(b: ProofBundle): number {
  return b.options.rulesVersion ?? (b.seasons.some((s) => 'deals' in s) ? 2 : 1);
}

/** Replays a bundle's seasons and returns the final state (no checks). */
export function replayBundle(b: ProofBundle): GameState {
  let state = newCampaign({ ...b.options, rulesVersion: rulesVersionOf(b) });
  for (const sp of b.seasons)
    state = replaySeason(state, { season: sp.season, treaties: sp.treaties, deals: sp.deals ?? [], orders: sp.seals.map((x) => x.orders), rollSeed: sp.rollSeed, events: [] }).state;
  return state;
}

/** Compares a bundle with what the contract recorded. `view` performs a contract view call. */
export async function checkAgainstChain(
  b: ProofBundle,
  view: (method: string, args: object) => Promise<unknown>,
): Promise<Check[]> {
  const checks: Check[] = [];
  const c = (await view('get_campaign', { campaign: b.campaign })) as {
    roll_commit: string;
    agenda_commits: string[];
    state_hashes: string[];
    map_seed: string;
    realms: unknown[];
  } | null;
  if (!c) return [{ name: `campaign ${b.campaign} exists on ${b.contract}`, ok: false }];
  // once a campaign is over every job is settled, so each onchain treasury must equal the
  // replayed crowns: a hire or refund the bundle missed would show up here
  if (b.rollSecret !== undefined) {
    const end = replayBundle(b);
    const onchain = (c as unknown as { realms: { treasury: number }[] }).realms.map((r) => r.treasury);
    const replayed = end.realms.map((r) => r.purse.crowns);
    checks.push({
      name: 'every onchain treasury equals the replayed crowns',
      ok: canonicalJson(onchain) === canonicalJson(replayed),
      ...(canonicalJson(onchain) === canonicalJson(replayed) ? {} : { detail: `onchain ${onchain.join(',')} vs replayed ${replayed.join(',')}` }),
    });
  }
  checks.push({ name: 'onchain map seed matches', ok: c.map_seed === b.options.seed });
  checks.push({ name: 'onchain roll commitment matches', ok: c.roll_commit === b.rollCommit });
  checks.push({ name: 'onchain agenda commitments match', ok: canonicalJson(c.agenda_commits) === canonicalJson(b.agendaCommits) });
  for (const j of b.jobs ?? []) {
    const rec = (await view('get_job', { job: j.job })) as { status: string; price: number; delivery: string | null; worker: string } | null;
    const status = j.passed ? 'Paid' : 'Refunded';
    checks.push({
      name: `job ${j.job}: onchain it is ${status}, at the price and delivery in the bundle`,
      ok: !!rec && rec.status === status && rec.price === j.deal.price && rec.delivery === j.delivery && rec.worker === j.worker,
    });
  }
  for (const sp of b.seasons) {
    checks.push({ name: `season ${sp.season}: onchain state hash matches`, ok: c.state_hashes[sp.season] === sp.stateHash });
    for (const x of sp.seals) {
      const rec = (await view('get_seal', { campaign: b.campaign, season: sp.season, realm: x.realm })) as { seal: string } | null;
      checks.push({ name: `season ${sp.season}: realm ${x.realm}'s seal is the one posted onchain`, ok: rec?.seal === x.seal });
    }
    for (const r of sp.forfeited ?? []) {
      // the contract settles a forfeited realm only if it sealed and never revealed, and only
      // after its ruler's own forfeit or once the reveal window closed
      const [rec, declared] = await Promise.all([
        view('get_seal', { campaign: b.campaign, season: sp.season, realm: r }) as Promise<{ revealed: boolean } | null>,
        view('get_forfeit', { campaign: b.campaign, season: sp.season, realm: r }).catch(() => null) as Promise<boolean | null>,
      ]);
      checks.push({
        name: `season ${sp.season}: realm ${r} sealed but never revealed onchain`,
        ok: !!rec && !rec.revealed,
        detail: declared ? 'forfeited by its ruler onchain' : 'not forfeited by its ruler: the contract allows that only after the reveal window',
      });
    }
    // every seal onchain is accounted for: revealed in the bundle, or listed as forfeited
    const accounted = new Set([...sp.seals.map((x) => x.realm), ...(sp.forfeited ?? [])]);
    const others = c.realms.map((_, r) => r).filter((r) => !accounted.has(r));
    const posted = await Promise.all(others.map((r) => view('get_seal', { campaign: b.campaign, season: sp.season, realm: r })));
    const missing = others.filter((_, i) => posted[i]);
    checks.push({
      name: `season ${sp.season}: every seal onchain is revealed or forfeited in the bundle`,
      ok: missing.length === 0,
      ...(missing.length > 0 ? { detail: `realms ${missing.join(', ')} sealed but are missing` } : {}),
    });
  }
  return checks;
}
