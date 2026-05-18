/**
 * Client Entry Point
 *
 * Wires the wallet UI to the game bootstrap. Game only starts after
 * the user has connected a wallet. Spectate-via-URL is handled here
 * (after the wallet is connected) rather than inside GameScene.
 */

import { GameLoop } from './engine/GameLoop';
import { GameScene } from './game/scenes/GameScene';
import { initWalletUI } from './wallet/walletUI';

const canvas = document.getElementById('game') as HTMLCanvasElement;

// Block the canvas visually until connected
canvas.style.filter = 'blur(8px) brightness(0.4)';
canvas.style.pointerEvents = 'none';

initWalletUI(
  {
    connectBtn: document.getElementById('connectBtn') as HTMLButtonElement,
    walletList: document.getElementById('walletList') as HTMLDivElement,
    walletInfo: document.getElementById('walletInfo') as HTMLDivElement,
  },
  (session) => {
    canvas.style.filter = '';
    canvas.style.pointerEvents = '';

    const loop  = new GameLoop(canvas);
    const scene = new GameScene(canvas, session);
    loop.setScene(scene);
    loop.start();

    // Spectate URL? Now that we have a wallet, act on it.
    const spectateLobby = new URLSearchParams(location.search).get('spectate');
    if (spectateLobby) scene.startSpectate(spectateLobby);
  },
);