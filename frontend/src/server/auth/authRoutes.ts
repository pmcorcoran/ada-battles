/**
 * Express routes for the wallet-auth handshake.
 * Pure translation layer — all logic is in AuthService.
 */

import { Router } from 'express';
import type { AuthService } from './authService';

export function createAuthRouter(auth: AuthService): Router {
  const router = Router();

  router.get('/nonce', (req, res) => {
    const address = String(req.query.address ?? '');
    console.log('[auth] nonce request — address:', JSON.stringify(address), 'length:', address.length);
    try {
      const nonce = auth.issueNonce(address);
      if (!nonce) {
        console.log('[auth] issueNonce returned null');
        return res.status(400).json({ error: 'invalid address' });
      }
      res.json({ nonce });
    } catch (err) {
      console.error('[auth] EXCEPTION in /nonce route:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/verify', (req, res) => {
    const { address, signature } = req.body ?? {};
    if (typeof address !== 'string' || !signature) {
      return res.status(400).json({ error: 'missing fields' });
    }
    try {
      const token = auth.verify(address, signature);
      if (!token) return res.status(401).json({ error: 'verification failed' });
      res.json({ token });
    } catch (err) {
      console.error('[auth] /verify exception:', err);
      res.status(500).json({ error: 'verification error' });
    }
  });

  return router;
}