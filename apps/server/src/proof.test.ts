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
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const state = newCampaign({ seed: 'proof-test', realms: 3, human: 0, maxSeasons: 4, rulesVersion: 3 });
    // the reply as signed by the model's TEE, its request naming the ruler's secret aim
    const signed = { ...reply, signatureKind: 'provider_tee', response: '{"id":"chatcmpl-abc","choices":[{"message":{"content":"the iron hills"}}]}' };
    writeFileSync(
      join(dir, 'campaign-3.json'),
      JSON.stringify({
        id: 3,
        phase: 'planning',
        state,
        pending: { ai: [], jobs: [], deals: [], treaties: [] },
        bundle: { options: { seed: 'proof-test', realms: 3, human: 0, maxSeasons: 4, rulesVersion: 3 }, seasons: [], replies: [signed, { ...signed, signatureKind: 'unknown' }] },
        envoys: [
          { season: 0, to: 1, message: 'peace?', reply: 'hm', signed: 0 },
          { season: 0, to: 2, message: 'war?', reply: 'no', signed: 1 },
        ],
        plans: [],
        reports: [],
        intents: [],
        chancellorBudget: 0,
        lastEvents: [],
        createdAt: 3,
      }),
    );
    await host.loadAll();
    const url = host.publicView(3).envoys[0]!.verifyUrl!;
    expect(url.startsWith('https://cloud.near.ai/verify?model=m#receipt=')).toBe(true);
    const receipt = JSON.parse(Buffer.from(url.split('#receipt=')[1]!, 'base64url').toString('utf8'));
    expect(receipt).toEqual({ completionId: 'chatcmpl-abc', model: 'm', signatureKind: 'provider_tee', signingAlgo: 'ecdsa', signingAddress: '0x1', signedText: 't', signature: 's' });
    // nothing the request asked or the response said
    expect(url).not.toContain(Buffer.from('iron hills').toString('base64url').slice(0, 8));
    expect(JSON.stringify(receipt)).not.toContain('iron hills');
    // a signature kind the page wouldn't take: no link
    expect(host.publicView(3).envoys[1]!.verifyUrl).toBeNull();
  });

});
