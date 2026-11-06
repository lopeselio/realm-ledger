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
  type Agenda,
  type GameState,
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

export interface SeasonProof {
  season: number;
  treaties: Treaty[];
  /** one per realm that sealed */
  seals: { realm: number; seal: string; salt: string; orders: OrderSet }[];
  rollSeed: string;
  /** stateHash after the season resolved */
  stateHash: string;
}

export interface ProofBundle {
  version: 1;
  contract: string;
  campaign: number;
  options: { seed: string; realms: number; human: number | null; maxSeasons: number };
  rollCommit: string;
  agendaCommits: string[];
  /** revealed when the campaign ends */
  rollSecret?: string;
  rollSalt?: string;
  agendaSalts?: string[];
  seasons: SeasonProof[];
  replies: SignedReply[];
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

  let state: GameState = newCampaign({ ...b.options });
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
    const result = replaySeason(state, {
      season: sp.season,
      treaties: sp.treaties,
      orders: sp.seals.map((x) => x.orders),
      rollSeed: sp.rollSeed,
      events: [],
    });
    state = result.state;
    const h = stateHash(state);
    push(`season ${sp.season}: replay reaches the recorded state`, h === sp.stateHash, h === sp.stateHash ? undefined : `got ${h}`);
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
  } | null;
  if (!c) return [{ name: `campaign ${b.campaign} exists on ${b.contract}`, ok: false }];
  checks.push({ name: 'onchain map seed matches', ok: c.map_seed === b.options.seed });
  checks.push({ name: 'onchain roll commitment matches', ok: c.roll_commit === b.rollCommit });
  checks.push({ name: 'onchain agenda commitments match', ok: canonicalJson(c.agenda_commits) === canonicalJson(b.agendaCommits) });
  for (const sp of b.seasons) {
    checks.push({ name: `season ${sp.season}: onchain state hash matches`, ok: c.state_hashes[sp.season] === sp.stateHash });
    for (const x of sp.seals) {
      const rec = (await view('get_seal', { campaign: b.campaign, season: sp.season, realm: x.realm })) as { seal: string } | null;
      checks.push({ name: `season ${sp.season}: realm ${x.realm}'s seal is the one posted onchain`, ok: rec?.seal === x.seal });
    }
  }
  return checks;
}
