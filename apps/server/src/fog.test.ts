import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newCampaign, visibleProvinces, type GameEvent } from '@realm-ledger/rules';

const dir = mkdtempSync(join(tmpdir(), 'realm-ledger-fog-'));
process.env.DATA_DIR = dir;

// a campaign whose last season had a march in sight, one in the fog, and one arriving from the fog
function save(id: number, phase: 'planning' | 'over', opts: { winner?: number | null; fell?: boolean } = {}) {
  const state = newCampaign({ seed: 'fog-test', realms: 3, human: 0, maxSeasons: 4, rulesVersion: 2 });
  // a finished campaign has its winner (unless set otherwise); a running one can already have one
  // while the onchain finish completes
  if (phase === 'over' && opts.winner !== null) state.winner = 1;
  if (opts.winner !== undefined && opts.winner !== null) state.winner = opts.winner;
  // you fell: your realm is gone, its capital someone else's
  if (opts.fell) {
    state.realms[0]!.alive = false;
    state.owner = state.owner.map((o) => (o === 0 ? 1 : o));
  }
  // the season that ended it: its victory event names every realm's full score
  const victory = state.winner !== null ? [{ kind: 'victory', realm: state.winner, reason: 'last-winter', scores: [100, 200, 300] }] : [];
  const seen = visibleProvinces(state, 0);
  const inSight = [...seen].find((p) => state.owner[p] !== 0)!;
  const fog = state.map.provinces.map((p) => p.id).filter((p) => !seen.has(p));
  const t = { levies: 1, regulars: 0, mercs: 0 };
  const lastEvents: GameEvent[] = [
    { kind: 'moved', realm: 1, from: fog[0]!, to: fog[1]!, troops: t },
    { kind: 'moved', realm: 1, from: fog[2]!, to: inSight, troops: t },
    { kind: 'harvest', realm: 1, gained: { crowns: 9, grain: 0, timber: 0, iron: 0, gold: 0 } },
  ];
  writeFileSync(
    join(dir, `campaign-${id}.json`),
    JSON.stringify({
      id,
      phase,
      state,
      pending: { ai: [], jobs: [], deals: [], treaties: [] },
      bundle: { options: { seed: 'fog-test', realms: 3, human: 0, maxSeasons: 4, rulesVersion: 2 }, seasons: [], replies: [] },
      envoys: [],
      plans: [],
      reports: [],
      intents: [],
      chancellorBudget: 0,
      lastEvents: [...lastEvents, ...victory],
      lastSeen: [...seen],
      createdAt: id,
    }),
  );
  return { inSight, fog };
}

describe('the season the player is shown', () => {
  it('keeps what was in sight, masks where a rival came from, hides the rest; all of it once over', async () => {
    const a = save(1, 'planning');
    save(2, 'over');
    // the season that ended it resolved, the onchain finish not yet confirmed: still running
    save(3, 'planning', { winner: 2 });
    // you fell while rivals survive: over, with no winner in the state
    save(4, 'over', { winner: null, fell: true });
    const host = await import('./host.ts');
    expect(await host.loadAll()).toBe(4);
    const shown = host.publicView(1).lastEvents;
    expect(shown).toEqual([{ kind: 'moved', realm: 1, from: -1, to: a.inSight, troops: { levies: 1, regulars: 0, mercs: 0 } }]);
    expect(host.publicView(2).lastEvents).toHaveLength(4);
    // while it runs: land for everyone, your own full score, no final scores; once won, the final scores
    const running = host.publicView(1);
    expect(running.final).toBe(false);
    expect(running.holdings).toHaveLength(3);
    expect(running.yourScore).toBeGreaterThan(running.holdings[0]!);
    expect(host.publicView(2).scores).toHaveLength(3);
    // no rival's full score (and so treasury) before it's over, even with a winner in the state
    const finishing = host.publicView(3);
    expect(finishing.final).toBe(false);
    expect(finishing.scores).toEqual(finishing.holdings);
    expect(finishing.lastEvents.find((e) => e.kind === 'victory')).toMatchObject({ scores: [] });
    // over without a winner in the state: final scores, and the best of them named
    const fell = host.publicView(4);
    expect(fell.final).toBe(true);
    expect(fell.scores[0]).toBe(0);
    expect(fell.winner).toBe(fell.scores.indexOf(Math.max(...fell.scores)));
  });
});
