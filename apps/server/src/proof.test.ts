import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newCampaign, sha256Hex } from '@realm-ledger/rules';

const dir = mkdtempSync(join(tmpdir(), 'realm-ledger-proof-'));
process.env.DATA_DIR = dir;

const reply = { realm: 1, season: 0, model: 'm', request: '{"secret aim":"the iron hills"}', response: '{"reply":"hm"}', text: 't', signature: 's', signingAddress: '0x1', signatureKind: 'ecdsa' };

function save(id: number, phase: 'planning' | 'over') {
  const state = newCampaign({ seed: 'proof-test', realms: 3, human: 0, maxSeasons: 4, rulesVersion: 3 });
  writeFileSync(
    join(dir, `campaign-${id}.json`),
    JSON.stringify({
      id,
      phase,
      state,
      pending: { ai: [], jobs: [], deals: [], treaties: [] },
      bundle: { options: { seed: 'proof-test', realms: 3, human: 0, maxSeasons: 4, rulesVersion: 3 }, seasons: [], replies: [reply] },
      envoys: [],
      plans: [],
      reports: [],
      intents: [],
      chancellorBudget: 0,
      lastEvents: [],
      createdAt: id,
    }),
  );
}

describe('the proof served', () => {
  it("withholds replies' bytes while the campaign runs (their hashes stand in), and carries them once it's over", async () => {
    save(1, 'planning');
    save(2, 'over');
    const host = await import('./host.ts');
    await host.loadAll();
    const running = host.proof(1).replies[0]!;
    expect(running.request).toBeUndefined();
    expect(running.response).toBeUndefined();
    expect(running.requestHash).toBe(sha256Hex(reply.request));
    expect(running.responseHash).toBe(sha256Hex(reply.response));
    expect(JSON.stringify(host.proof(1))).not.toContain('iron hills');
    expect(host.proof(2).replies[0]).toMatchObject({ request: reply.request, response: reply.response });
  });
});

describe("an envoy's receipt for NEAR AI's Verification Center", () => {
  it('names the completion, model, signer and signed text, and none of what was asked', async () => {
    const host = await import('./host.ts');
    const { readFileSync } = await import('node:fs');
    // a real reply from NEAR AI Cloud's TEE-hosted model (the verifier's fixture)
    const fx = (f: string): string => readFileSync(join(import.meta.dirname, '../../../packages/verify/test/fixtures', f), 'utf8');
    const sig = JSON.parse(fx('signature.json')) as { text: string; signature: string; signing_address: string; signature_kind: string };
    const model = 'Qwen/Qwen3.6-35B-A3B-FP8';
    const signed = { realm: 1, season: 0, model, request: fx('request.json'), response: fx('response.json'), text: sig.text, signature: sig.signature, signingAddress: sig.signing_address, signatureKind: sig.signature_kind };
    const state = newCampaign({ seed: 'proof-test', realms: 3, human: 0, maxSeasons: 4, rulesVersion: 3 });
    writeFileSync(
      join(dir, 'campaign-3.json'),
      JSON.stringify({
        id: 3,
        phase: 'planning',
        state,
        pending: { ai: [], jobs: [], deals: [], treaties: [] },
        bundle: {
          options: { seed: 'proof-test', realms: 3, human: 0, maxSeasons: 4, rulesVersion: 3 },
          seasons: [],
          // as saved before the id was kept; a kind the page wouldn't take; the id kept; an algorithm the check here doesn't do; tampered
          replies: [signed, { ...signed, signatureKind: 'unknown' }, { ...signed, completionId: 'kept-id', signingAlgo: 'ecdsa' }, { ...signed, signingAlgo: 'ed25519' }, { ...signed, signingAddress: '0x0000000000000000000000000000000000000001' }],
        },
        envoys: [0, 1, 2, 3, 4].map((i) => ({ season: 0, to: 1, message: 'peace?', reply: 'hm', signed: i })),
        plans: [],
        reports: [],
        intents: [],
        chancellorBudget: 0,
        lastEvents: [],
        createdAt: 3,
      }),
    );
    await host.loadAll();
    const envoys = host.publicView(3).envoys;
    const receiptOf = (url: string) => {
      expect(url.startsWith(`https://cloud.near.ai/verify?model=${encodeURIComponent(model)}#receipt=`)).toBe(true);
      return JSON.parse(Buffer.from(url.split('#receipt=')[1]!, 'base64url').toString('utf8'));
    };
    // exactly these fields, so nothing the request asked or the response said
    expect(receiptOf(envoys[0]!.verifyUrl!)).toEqual({
      completionId: (JSON.parse(fx('response.json')) as { id: string }).id,
      model,
      signatureKind: 'provider_tee',
      signingAlgo: 'ecdsa',
      signingAddress: sig.signing_address,
      signedText: sig.text,
      signature: sig.signature,
    });
    expect(envoys[1]!.verifyUrl).toBeNull();
    expect(receiptOf(envoys[2]!.verifyUrl!)).toMatchObject({ completionId: 'kept-id', signingAlgo: 'ecdsa' });
    expect(envoys[3]!.verifyUrl).toBeNull();
    // a reply whose signature doesn't check out here gets no badge and no link
    expect(envoys[4]).toMatchObject({ verified: false, verifyUrl: null });
  });
});
