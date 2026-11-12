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
    const signed = { ...reply, response: '{"id":"chatcmpl-abc","choices":[]}' };
    writeFileSync(
      join(dir, 'campaign-3.json'),
      JSON.stringify({
        id: 3,
        phase: 'planning',
        state,
        pending: { ai: [], jobs: [], deals: [], treaties: [] },
        bundle: { options: { seed: 'proof-test', realms: 3, human: 0, maxSeasons: 4, rulesVersion: 3 }, seasons: [], replies: [signed] },
        envoys: [{ season: 0, to: 1, message: 'peace?', reply: 'hm', signed: 0 }],
        plans: [],
        reports: [],
        intents: [],
        chancellorBudget: 0,
        lastEvents: [],
        createdAt: 3,
      }),
    );
    await host.loadAll();
    const receipt = host.publicView(3).envoys[0]!.receipt;
    expect(receipt).toEqual({ completionId: 'chatcmpl-abc', model: 'm', signatureKind: 'ecdsa', signingAlgo: 'ecdsa', signingAddress: '0x1', signedText: 't', signature: 's' });
    expect(JSON.stringify(receipt)).not.toContain('iron hills');
  });
});
