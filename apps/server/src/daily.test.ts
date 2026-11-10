import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dailySeed, newCampaign, QUICK_MATCH } from '@realm-ledger/rules';

const dir = mkdtempSync(join(tmpdir(), 'realm-ledger-daily-'));
process.env.DATA_DIR = dir;

// campaigns on one day's map: two finished (one a conquest), one being played, and one on another day
function save(id: number, seed: string, phase: 'planning' | 'over', opts: { crowns?: number; conquest?: boolean; player?: string } = {}) {
  const state = newCampaign({ seed, realms: QUICK_MATCH.realms, human: 0, maxSeasons: QUICK_MATCH.maxSeasons, map: QUICK_MATCH.map });
  state.realms[0]!.purse.crowns = opts.crowns ?? 0;
  if (opts.conquest) {
    for (const r of state.realms) if (r.id !== 0) r.alive = false;
    state.winner = 0;
  }
  writeFileSync(
    join(dir, `campaign-${id}.json`),
    JSON.stringify({
      id,
      phase,
      state,
      pending: { ai: [], jobs: [], deals: [], treaties: [] },
      bundle: { options: { seed, realms: 3, human: 0, maxSeasons: 6, rulesVersion: 2, map: QUICK_MATCH.map }, seasons: [], replies: [] },
      envoys: [],
      plans: [],
      reports: [],
      intents: [],
      chancellorBudget: 0,
      lastEvents: [],
      createdAt: id,
      ...(opts.player ? { player: opts.player } : {}),
    }),
  );
}

describe("the daily challenge's board", () => {
  it('ranks finished campaigns on the day by score, a conquest first, then those still playing', async () => {
    const day = '2026-11-10';
    save(1, dailySeed(day), 'over', { crowns: 500 });
    save(2, dailySeed(day), 'over', { crowns: 10, conquest: true, player: 'alice.testnet' });
    save(3, dailySeed(day), 'planning', { crowns: 9000 });
    save(4, dailySeed('2026-11-09'), 'over', { crowns: 9999 });
    const host = await import('./host.ts');
    await host.loadAll();
    const board = host.dailyBoard(day);
    expect(board.map((e) => [e.id, e.rank, e.conquest])).toEqual([
      [2, 1, true],
      [1, 2, false],
      [3, null, false],
    ]);
    expect(board[0]!.player).toBe('alice.testnet');
  });
});
