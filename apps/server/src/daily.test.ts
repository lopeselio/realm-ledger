import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { challengeSeed, dailySeed, newCampaign, QUICK_MATCH, utcDay } from '@realm-ledger/rules';

const dir = mkdtempSync(join(tmpdir(), 'realm-ledger-daily-'));
process.env.DATA_DIR = dir;

// campaigns on one day's map: two finished (one a conquest), one being played, and one on another day
function save(id: number, seed: string, phase: 'planning' | 'over', opts: { crowns?: number; conquest?: boolean; player?: string; neverPlayed?: boolean; createdAt?: number } = {}) {
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
      createdAt: opts.createdAt ?? id,
      ...(opts.player ? { player: opts.player } : {}),
    }),
  );
}

describe("the daily challenge's board", () => {
  // one clock for the whole file, so a run across midnight can't change "today"
  let now = 0;
  let day = '';
  const before = '2026-01-02';
  let host: typeof import('./host.ts');
  beforeAll(async () => {
    // one clock for the whole test, so a run across midnight can't change "today"
    now = Date.now();
    day = utcDay(now);
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
    save(9, challengeSeed('a1b2c3'), 'planning', { crowns: 5, createdAt: Date.now() });
    // one accepted long ago and left: not "still playing"
    save(10, challengeSeed('a1b2c3'), 'planning', { crowns: 5, createdAt: Date.now() - 3 * 86_400_000 });
    host = await import('./host.ts');
    await host.loadAll();
  });

  it("ranks today's finished campaigns by score, a conquest first, then those still playing; an earlier day shows only its finished", async () => {
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
    expect(host.challengeBoard('a1b2c3').map((e) => [e.id, e.rank])).toEqual([
      [8, 1],
      [9, null],
    ]);
    expect(host.challengeExists('a1b2c3')).toBe(true);
    expect(host.challengeExists('ffffff')).toBe(false);
    await expect(host.createCampaign(3, 6, undefined, true, false, 'ffffff')).rejects.toThrow('no such challenge');
    await expect(host.createCampaign(3, 6, undefined, true, true, 'a1b2c3')).rejects.toThrow('not both');
    // the fixtures' challenge was made under rules version 2: a join now would get another setup, so it's refused
    await expect(host.createCampaign(3, 6, undefined, true, false, 'a1b2c3')).rejects.toThrow('older rules');
    // the board names the seed the challenge's campaigns really play
    expect(host.challengeSeedOf('a1b2c3')).toBe(challengeSeed('a1b2c3'));
    expect(host.challengeSeedOf('ffffff')).toBeNull();
  });
});

