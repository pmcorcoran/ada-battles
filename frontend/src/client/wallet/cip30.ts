/**
 * CIP-30 Wallet Bridge
 *
 * Types and helpers for talking to Cardano browser wallets via the
 * standard window.cardano API. No external dependencies.
 */

export interface Cip30WalletInfo {
  apiVersion: string;
  name: string;
  icon: string;
  enable: () => Promise<Cip30Api>;
  isEnabled: () => Promise<boolean>;
}

export interface Cip30Api {
  getNetworkId: () => Promise<number>;
  getChangeAddress: () => Promise<string>;
  getUsedAddresses: () => Promise<string[]>;
  getRewardAddresses: () => Promise<string[]>;
  signData: (
    addr: string,
    payload: string,
  ) => Promise<{ signature: string; key: string }>;
  signTx: (tx: string, partialSign: boolean) => Promise<string>;
  submitTx: (tx: string) => Promise<string>;
}

declare global {
  interface Window {
    cardano?: Record<string, Cip30WalletInfo>;
  }
}

export interface InstalledWallet {
  id: string;
  info: Cip30WalletInfo;
}

export function getInstalledWallets(): InstalledWallet[] {
  const cardano = window.cardano;
  if (!cardano) return [];
  return Object.keys(cardano)
    .filter((id) => cardano[id]?.apiVersion && cardano[id]?.enable)
    .map((id) => ({ id, info: cardano[id] }));
}

export function hexEncode(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}