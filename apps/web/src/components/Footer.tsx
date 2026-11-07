import type { ReactNode } from 'react';

export function Footer({ children }: { children: ReactNode }) {
  return (
    <footer className="foot">
      {children} · Built for NEAR HACKATHON 2026 ·{' '}
      <a href="https://github.com/lopeselio/realm-ledger" target="_blank" rel="noopener">
        source
      </a>
    </footer>
  );
}
