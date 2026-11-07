import './style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { Watch } from './routes/Watch.tsx';
import { LegacyPlay, Play } from './routes/Play.tsx';

function NotFound() {
  return (
    <main className="notfound">
      <title>Not found · Realm Ledger</title>
      <h1>No such road</h1>
      <p>
        <Link to="/">Watch a campaign</Link> or <Link to="/play">play one</Link>.
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route index element={<Watch />} />
        <Route path="play/:id?" element={<Play />} />
        <Route path="play.html" element={<LegacyPlay />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
