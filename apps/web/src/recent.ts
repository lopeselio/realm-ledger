// The campaigns you played in this browser, newest first, so /play can offer to continue them.
const KEY = 'realm-ledger:recent';
const MAX = 20;

export function recentCampaigns(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}

export function rememberCampaign(id: number): void {
  try {
    const ids = recentCampaigns();
    if (ids[0] === id) return;
    localStorage.setItem(KEY, JSON.stringify([id, ...ids.filter((x) => x !== id)].slice(0, MAX)));
  } catch {
    // private mode: nothing to continue from next time
  }
}
