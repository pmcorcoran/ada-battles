/**
 * Express app for the matchmaker:
 *   GET  /api/lobbies
 *   POST /api/lobbies/match
 *   GET  /healthz
 *   Plus static client bundle + SPA fallback.
 */

import express, { type Express } from 'express';
import path from 'path';
import type { Matchmaker } from './Matchmaker';
import { issueChallenge } from '../../../shared/authChallenge';

export function createApp(matchmaker: Matchmaker, authSecret: string): Express {
  const app = express();
  app.use(express.json());

  // Static client bundle + SPA fallback so deep links work.
  app.use(express.static(path.join(__dirname, '../../../../public')));
  app.get(/^(?!\/api\/|\/lobby\/|\/healthz).*/, (_req, res) => {
    res.sendFile(path.join(__dirname, '../../../../public/index.html'));
  });

  app.get('/api/lobbies', (_req, res) => {
    res.json(matchmaker.list().map((l) => ({
      id:          l.id,
      maxPlayers:  l.maxPlayers,
      playerCount: l.playerCount,
      status:      l.status,
    })));
  });

  app.post('/api/lobbies/match', async (req, res) => {
    const maxPlayers = Number(req.body?.maxPlayers ?? 2);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 7) {
      res.status(400).json({ error: 'maxPlayers must be an integer in [2, 7]' });
      return;
    }
    try {
      const record    = await matchmaker.match(maxPlayers);
      const challenge = issueChallenge(record.id, authSecret);
      res.json({
        lobbyId:   record.id,
        wsUrl:     record.wsUrl,
        challenge,
      });
    } catch (e) {
      console.error('match failed:', e);
      res.status(503).json({ error: 'no capacity' });
    }
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  return app;
}