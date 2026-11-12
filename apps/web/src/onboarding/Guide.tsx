// The play page's guide: the welcome on a first visit, the walkthrough, and the "?" button
// that brings either back along with the rules sheet.
import { useCallback, useEffect, useRef, useState } from 'react';
import { HelpSheet } from './HelpSheet.tsx';
import { markWelcomeSeen, welcomeSeen } from './storage.ts';
import { Tour, type TourStep } from './Tour.tsx';
import { Welcome } from './Welcome.tsx';

/** What the walkthrough watches to move on when the player acts. */
export interface GuideSignals {
  campaign: number | null;
  /** how many orders the player has added or changed (a reset or a removal doesn't count) */
  orderEdits: number;
  /** how many marches the player has ordered on the map (a market trade doesn't count) */
  marches: number;
  /** how many times the player has selected a province or army */
  selections: number;
  /** how many times the player has sealed */
  seals: number;
}

const STEPS: TourStep<GuideSignals>[] = [
  {
    target: '[data-tour="start"]',
    title: 'Start a campaign',
    body: <p>Pick a length: the quick match (2 AI rivals, 6 seasons, a small map) or a full map, where you also pick how many rivals. Then press New campaign. The campaign is created on the NEAR testnet contract.</p>,
    hint: 'Press New campaign: the rest of the tour needs an open campaign.',
    next: 'Skip the table tour',
    // a campaign opened (not one closing, or the view clearing while it reloads)
    acted: (before, now) => now.campaign !== null && now.campaign !== before.campaign,
  },
  {
    target: '[data-tour="map"]',
    title: 'The war table',
    body: (
      <p>
        Your realm is red. Mist covers ground you can’t see. Hover a province for its yield and garrison; on the 3D table, drag to turn and scroll to zoom.
      </p>
    ),
    hint: 'Click one of your provinces or your army.',
    // the player selected something, or gave a march straight away (which clears the selection);
    // deselecting, a season turn or a reload doesn't count
    acted: (before, now) => now.selections > before.selections || now.marches > before.marches,
  },
  {
    target: '[data-tour="orders"]',
    title: 'Give orders',
    body: (
      <p>
        With your army selected, click a highlighted province, or one of the forecasts listed here, to march; each forecast gives your odds against what stands there. With one of your provinces selected, fortify, raise levies or build here. Orders list here; ✕ takes one back.
      </p>
    ),
    hint: 'Add or change an order to go on (or Next if you already have).',
    acted: (before, now) => now.orderEdits > before.orderEdits,
  },
  {
    target: '[data-tour="purse"]',
    title: 'Your treasury',
    body: <p>Crowns pay for everything. Armies eat grain; forts need timber and iron. Trade on the market just above when you’re short.</p>,
  },
  {
    target: '[data-tour="envoys"]',
    title: 'Talk to rivals',
    body: <p>Send an envoy with a message or a treaty. The engine decides whether they accept; the reply is in character, signed in a TEE, and may be a bluff.</p>,
  },
  {
    target: '[data-tour="seal"]',
    title: 'Seal your orders',
    body: (
      <p>
        When you’re ready, seal. Your browser hashes your orders with a secret salt and only the hash goes onchain. Every AI ruler seals at the same moment, so nobody moves first.
      </p>
    ),
    hint: 'Press End season to go on, or Next to look around first.',
    // the player sealed (not the view clearing, a season turning, or the campaign ending)
    acted: (before, now) => now.seals > before.seals,
  },
  {
    target: '[data-tour="status"]',
    title: 'Reveal and the season’s clock',
    body: (
      <p>
        After the seals, your browser reveals and the contract checks it against your seal. The season turns about ten seconds later. This line tells you what’s happening and any deadline;
        the Chronicle lists what everyone did.
      </p>
    ),
  },
  {
    target: '[data-tour="realms"]',
    title: 'Score and victory',
    body: (
      <p>
        Each realm’s score: crowns, goods at market price, and every province, town and fort it holds (a city, grown from a town other than the capital held 4 harvests in peace, and a shrine ✦ count extra). Highest when the last season turns wins, or be the last realm standing (a realm
        falls when its capital is taken).
      </p>
    ),
  },
  {
    target: '[data-tour="proof"]',
    title: 'Check it yourself',
    body: <p>Everything here is on the NEAR testnet. The proof panel links the contract and gives one command that replays and checks the whole campaign.</p>,
  },
  {
    target: '[data-tour="account"]',
    title: 'Your wallet',
    body: (
      <p>
        Sign in with a NEAR testnet wallet and your own account rules your realm; your browser signs each seal and reveal without popups. Or keep playing as a guest.
      </p>
    ),
  },
];

type Open = 'none' | 'welcome' | 'tour' | 'help';

/**
 * `quiet`: hold the welcome back for now (a linked campaign still loading); once quiet ends, a
 * first visit still gets it, once. `hold`: hold it back for this whole visit (a finished campaign
 * opened from a link; it shows on the next visit instead).
 */
export function Guide({ signals, quiet = false, hold = false }: { signals: GuideSignals; quiet?: boolean; hold?: boolean }) {
  const [open, setOpen] = useState<Open>(() => (welcomeSeen() || quiet || hold ? 'none' : 'welcome'));
  const held = useRef(hold);
  if (hold) held.current = true;
  const offered = useRef(!quiet && !hold);
  useEffect(() => {
    if (hold) setOpen((o) => (o === 'welcome' ? 'none' : o));
    if (quiet || held.current || offered.current) return;
    offered.current = true;
    if (!welcomeSeen()) setOpen((o) => (o === 'none' ? 'welcome' : o));
  }, [quiet, hold]);

  const closeWelcome = useCallback(() => {
    markWelcomeSeen();
    setOpen('none');
  }, []);
  const startTour = useCallback(() => {
    markWelcomeSeen();
    setOpen('tour');
  }, []);
  const close = useCallback(() => setOpen('none'), []);

  return (
    <>
      <button type="button" className="ob-help-btn" aria-haspopup="dialog" onClick={() => setOpen('help')} title="How to play">
        <span aria-hidden="true">?</span> How to play
      </button>
      {open === 'welcome' && <Welcome onClose={closeWelcome} onTour={startTour} />}
      {open === 'tour' && <Tour steps={STEPS} signals={signals} onClose={close} />}
      {open === 'help' && <HelpSheet onClose={close} onWelcome={() => setOpen('welcome')} onTour={startTour} />}
    </>
  );
}
