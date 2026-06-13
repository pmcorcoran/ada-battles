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
  ?? 'ghcr.io/cardano-scaling/hydra-node:2.0.0';
// N+1 layout root (shared/ + parties/p0..pK/) — see the header of
// DockerOrchestrator.ts for the exact expected contents, and the
// Makefile's hydra-party-keys target for provisioning it.
const HYDRA_DEV_KEYS_HOST_PATH = required('HYDRA_DEV_KEYS_HOST_PATH');
// Optional N+1 tuning knobs; the orchestrator defaults are 5001 / 512 MiB.
const HYDRA_NETWORK_PORT = numberOrUndefined(process.env.HYDRA_NETWORK_PORT);
const HYDRA_MEMORY_MB    = numberOrUndefined(process.env.HYDRA_MEMORY_MB);

const orchestrator = new DockerOrchestrator({
  runnerImage:          RUNNER_IMAGE,
  network:              RUNNER_NETWORK,
  hydraImage:           HYDRA_NODE_IMAGE,
  hydraDevKeysHostPath: HYDRA_DEV_KEYS_HOST_PATH,
  hydraNetworkPort:     HYDRA_NETWORK_PORT,
  hydraMemoryBytes:     HYDRA_MEMORY_MB !== undefined
    ? HYDRA_MEMORY_MB * 1024 * 1024
    : undefined,
  authSecret:           AUTH_SECRET,
});

const matchmaker   = new Matchmaker(
  orchestrator,
  (id) => `ws://${PUBLIC_WS_HOST}:${PUBLIC_PORT}/lobby/${id}`,
);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
  console.warn('ALLOWED_ORIGINS not set — CORS/WS origin checks disabled');
}

const app    = createApp(matchmaker, AUTH_SECRET, ALLOWED_ORIGINS);
const server = http.createServer(app);
attachWsProxy(server, matchmaker, ALLOWED_ORIGINS);

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

function numberOrUndefined(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}