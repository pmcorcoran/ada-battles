/**
 * Client Entry Point
 *
 * Wires the wallet UI to the game bootstrap. Game only starts after
 * successful wallet auth.
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
  () => {
    canvas.style.filter = '';
    canvas.style.pointerEvents = '';

    const loop  = new GameLoop(canvas);
    const scene = new GameScene(canvas);
    loop.setScene(scene);
    loop.start();
  },
);