/**
 * WalletUI
 *
 * Renders the connect button and wallet picker. On successful auth,
 * invokes the onConnected callback so the rest of the app can start.
 */

import { getInstalledWallets } from './cip30';
import { authenticateWithWallet, type AuthResult } from './walletAuth';

export interface WalletUIElements {
  connectBtn: HTMLButtonElement;
  walletList: HTMLDivElement;
  walletInfo: HTMLDivElement;
}

export function initWalletUI(
  els: WalletUIElements,
  onConnected: (result: AuthResult) => void,
): void {
  let connected = false;

  els.connectBtn.addEventListener('click', () => {
    if (connected) return;

    const installed = getInstalledWallets();
    if (installed.length === 0) {
      els.walletList.style.display = 'block';
      els.walletList.innerHTML = `<div style="color:#fff;font-size:12px;">No CIP-30 wallets found. Please install Eternl, Nami, or Lace.</div>`;
      return;
    }

    els.walletList.style.display = 'block';
    els.walletList.innerHTML = '';
    installed.forEach(({ id, info }) => {
      const btn = document.createElement('button');
      btn.style.cssText =
        'display:flex;align-items:center;gap:8px;width:100%;padding:6px;margin:2px 0;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;';
      btn.innerHTML = `<img src="${info.icon}" width="20" height="20"/> ${info.name}`;
      btn.onclick = () => attemptConnect(id, info);
      els.walletList.appendChild(btn);
    });
  });

  async function attemptConnect(
    _id: string,
    info: import('./cip30').Cip30WalletInfo,
  ): Promise<void> {
    els.walletList.style.display = 'none';
    try {
      const result = await authenticateWithWallet(info);
      connected = true;

      els.connectBtn.textContent = 'Connected';
      els.connectBtn.disabled = true;
      els.walletInfo.style.display = 'block';
      els.walletInfo.innerHTML = `<div style="color:#fff;font-size:11px;">${result.addressHex.slice(0, 16)}...${result.addressHex.slice(-8)}</div>`;

      onConnected(result);
    } catch (err) {
      console.error('Wallet connect failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      els.walletInfo.style.display = 'block';
      els.walletInfo.innerHTML = `<div style="color:#ff6666;">${
        msg.toLowerCase().includes('reject')
          ? 'Connection declined'
          : 'Authentication failed'
      }</div>`;
    }
  }
}