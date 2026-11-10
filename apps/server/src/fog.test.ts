import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newCampaign, visibleProvinces, type GameEvent } from '@realm-ledger/rules';

const dir = mkdtempSync(join(tmpdir(), 'realm-ledger-fog-'));
process.env.DATA_DIR = dir;

// a campaign whose last season had a march in sight, one in the fog, and one arriving from the fog
function save(id: number, phase: 'planning' | 'over') {
  const state = newCampaign({ seed: 'fog-test', realms: 3, human: 0, maxSeasons: 4, rulesVersion: 2 });
  // a finished campaign has its winner
  if (phase === 'over') state.winner = 1;
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
      lastEvents,
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
    const host = await import('./host.ts');
    expect(await host.loadAll()).toBe(2);
    const shown = host.publicView(1).lastEvents;
    expect(shown).toEqual([{ kind: 'moved', realm: 1, from: -1, to: a.inSight, troops: { levies: 1, regulars: 0, mercs: 0 } }]);
    expect(host.publicView(2).lastEvents).toHaveLength(3);
    // while it runs: land for everyone, your own full score, no final scores; once won, the final scores
    const running = host.publicView(1);
    expect(running.scores).toBeNull();
    expect(running.holdings).toHaveLength(3);
    expect(running.yourScore).toBeGreaterThan(running.holdings[0]!);
    expect(host.publicView(2).scores).toHaveLength(3);
  });
});
