import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { challengeSeed, dailySeed, newCampaign, QUICK_MATCH, utcDay } from '@realm-ledger/rules';

const dir = mkdtempSync(join(tmpdir(), 'realm-ledger-daily-'));
process.env.DATA_DIR = dir;

// campaigns on one day's map: two finished (one a conquest), one being played, and one on another day
function save(id: number, seed: string, phase: 'planning' | 'over', opts: { crowns?: number; conquest?: boolean; player?: string; neverPlayed?: boolean } = {}) {
  const state = newCampaign({ seed, realms: QUICK_MATCH.realms, human: 0, maxSeasons: QUICK_MATCH.maxSeasons, map: QUICK_MATCH.map, rulesVersion: 2 });
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
      bundle: {
        options: { seed, realms: 3, human: 0, maxSeasons: 6, rulesVersion: 2, map: QUICK_MATCH.map },
        // every season settled by the sweep without the player's orders
        seasons: opts.neverPlayed ? Array.from({ length: 6 }, (_, season) => ({ season, forfeited: [0] })) : [],
        replies: [],
      },
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
  it("ranks today's finished campaigns by score, a conquest first, then those still playing; an earlier day shows only its finished", async () => {
    // one clock for the whole test, so a run across midnight can't change "today"
    const now = Date.now();
    const day = utcDay(now);
    const before = '2026-01-02';
    save(1, dailySeed(day), 'over', { crowns: 500 });
    save(2, dailySeed(day), 'over', { crowns: 10, conquest: true, player: 'alice.testnet' });
    save(3, dailySeed(day), 'planning', { crowns: 9000 });
    save(4, dailySeed(before), 'over', { crowns: 9999 });
    save(5, dailySeed(before), 'planning', { crowns: 1 });
    save(6, dailySeed(day), 'over', { crowns: 99999, neverPlayed: true });
    // alice again, worse: a wallet counts once, by its best
    save(7, dailySeed(day), 'over', { crowns: 400, player: 'alice.testnet' });
    // a challenge between friends: its own board, unfinished ones counted as playing whatever the day
    save(8, challengeSeed('a1b2c3'), 'over', { crowns: 300 });
    save(9, challengeSeed('a1b2c3'), 'planning', { crowns: 5 });
    const host = await import('./host.ts');
    await host.loadAll();
    const board = host.dailyBoard(day, now);
    expect(board.map((e) => [e.id, e.rank, e.conquest])).toEqual([
      [2, 1, true],
      [1, 2, false],
      [3, null, false],
    ]);
    expect(board[0]!.player).toBe('alice.testnet');
    // an abandoned campaign from an earlier day isn't "still playing"
    expect(host.dailyBoard(before, now).map((e) => e.id)).toEqual([4]);
  });

  it("keeps a challenge's own board, and refuses to join a challenge no one made", async () => {
    const host = await import('./host.ts');
    expect(host.challengeBoard('a1b2c3').map((e) => [e.id, e.rank])).toEqual([
      [8, 1],
      [9, null],
    ]);
    expect(host.challengeExists('a1b2c3')).toBe(true);
    expect(host.challengeExists('ffffff')).toBe(false);
    await expect(host.createCampaign(3, 6, undefined, true, false, 'ffffff')).rejects.toThrow('no such challenge');
  });
});

