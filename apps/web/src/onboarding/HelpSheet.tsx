// "How to play": the rules and controls on one sheet, and the way back into the guide.
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { restoreFocus, typingIn } from './storage.ts';
import { trapFocus } from './Welcome.tsx';

export function HelpSheet({ onClose, onWelcome, onTour }: { onClose: () => void; onWelcome: () => void; onTour: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    box.current?.focus();
    return () => restoreFocus(before);
  }, []);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !typingIn(e.target)) {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') trapFocus(e, box.current);
  };

  return (
    <div className="ob-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ob-card ob-help" role="dialog" aria-modal="true" aria-labelledby="ob-help-title" tabIndex={-1} ref={box} onKeyDown={onKey}>
        <div className="ob-help-head">
          <h2 id="ob-help-title">How to play</h2>
          <button type="button" className="ob-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="ob-actions">
          <button type="button" className="primary" onClick={onTour}>
            Start the walkthrough
          </button>
          <button type="button" onClick={onWelcome}>
            Replay the welcome
          </button>
        </div>

        <h3>A season</h3>
        <ol className="ob-beats">
          <li>
            <strong>Plan:</strong> give orders, send envoys, give the Chancellor a task.
          </li>
          <li>
            <strong>Seal:</strong> press <em>Seal orders</em>. Only a hash of your orders and a secret salt goes onchain.
          </li>
          <li>
            <strong>Reveal:</strong> every ruler opens their orders and the contract checks each against its seal. Keep this tab open until the season turns; if you close it, the reveal
            finishes when you come back in the same browser.
          </li>
          <li>
            <strong>Turn:</strong> all orders resolve at once. Read the chronicle, then plan the next season.
          </li>
        </ol>

        <h3>Orders</h3>
        <ul className="ob-list">
          <li>
            <strong>March:</strong> click your army (red circle), then a highlighted neighbouring province. Armies entering the same province fight.
          </li>
          <li>
            <strong>Fortify, levy, recruit, build:</strong> select one of your provinces and press its button in <em>Your orders</em>. Each shows its cost.
          </li>
          <li>
            <strong>Trade:</strong> buy or sell grain, timber, iron or gold on the market. Prices follow supply and war.
          </li>
          <li>
            <strong>Undo:</strong> ✕ removes an order before you seal. Sealing with no orders is allowed.
          </li>
        </ul>

        <h3>Winning</h3>
        <p>
          The campaign ends when one realm stands or the last season turns. A realm falls when its capital is taken. Otherwise the highest score wins: crowns, goods at market price, and
          each province, town and fort you hold. Scores are in <em>Realms</em>.
        </p>

        <h3>Fair play on NEAR</h3>
        <p>
          Seals are posted to the <code>realm-ledger.testnet</code> contract before anyone reveals, so no order changes after the fact. Battle rolls and the AI rulers’ agendas are
          committed at the start. Envoy replies are signed inside a TEE. <em>The proof</em> panel gives the command to check a campaign yourself.
        </p>

        <h3>Controls</h3>
        <ul className="ob-list">
          <li>Hover a province for its yield and garrison.</li>
          <li>3D table: drag to turn it, scroll to zoom. “Flat map” switches to the 2D map.</li>
          <li>Guide: Enter or → for next, ← for back, Esc to skip or close.</li>
          <li>Wallet: sign in with a NEAR testnet wallet once; after that your browser signs each seal and reveal with no popup. Or play as a guest.</li>
        </ul>
      </div>
    </div>
  );
}
