/**
 * Matchmaker entry. Reads env, wires together the orchestrator,
 * matchmaker, HTTP app, and WS proxy, then listens.
 */

import http from 'http';
import { DockerOrchestrator } from './orchestrator/DockerOrchestrator';
import { Matchmaker } from './Matchmaker';
import { createApp } from './http';
import { attachWsProxy } from './wsProxy';

const AUTH_SECRET    = required('AUTH_SECRET');
const PORT           = Number(process.env.PORT ?? 8080);
const RUNNER_IMAGE   = process.env.RUNNER_IMAGE   ?? 'ada-battles:latest';
const RUNNER_NETWORK = process.env.RUNNER_NETWORK ?? 'ada-battles-net';
const PUBLIC_WS_HOST = process.env.PUBLIC_WS_HOST ?? 'localhost';
const PUBLIC_PORT    = process.env.PUBLIC_PORT    ?? '8080';

const HYDRA_NODE_IMAGE         = process.env.HYDRA_NODE_IMAGE
  ?? 'ghcr.io/cardano-scaling/hydra-node:1.2.0';
const HYDRA_DEV_KEYS_HOST_PATH = required('HYDRA_DEV_KEYS_HOST_PATH');

const orchestrator = new DockerOrchestrator({
  runnerImage:          RUNNER_IMAGE,
  network:              RUNNER_NETWORK,
  hydraImage:           HYDRA_NODE_IMAGE,
  hydraDevKeysHostPath: HYDRA_DEV_KEYS_HOST_PATH,
  authSecret:           AUTH_SECRET,
});

const matchmaker   = new Matchmaker(
  orchestrator,
  (id) => `ws://${PUBLIC_WS_HOST}:${PUBLIC_PORT}/lobby/${id}`,
);

const app    = createApp(matchmaker, AUTH_SECRET);
const server = http.createServer(app);
attachWsProxy(server, matchmaker);

setInterval(() => { void matchmaker.reap(); }, 10_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Matchmaker listening on :${PORT}`);
  console.log(`  RUNNER_IMAGE=${RUNNER_IMAGE}`);
  console.log(`  RUNNER_NETWORK=${RUNNER_NETWORK}`);
});

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  return v;
}