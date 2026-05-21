/**
 * Narrow types for the hydra-node WebSocket API.
 *
 * Scope: just enough to drive slice-1 observer logic. The hydra-node
 * emits a much richer vocabulary — `SnapshotConfirmed`, `TxValid`,
 * `CommandFailed`, `PeerConnected`, etc. — but slice 1 is purely an
 * observer and doesn't need to model them. When tx submission and
 * snapshot tracking land in slice 2 these types will grow.
 *
 * Intentionally not promoted to shared/types.ts: these are an
 * internal vocabulary, not a wire contract with the client.
 *
 * Reference: https://hydra.family/head-protocol/api-reference
 */

/** Coarse status used by HydraObserver. Not a hydra-node concept;
 *  it's our reduction of the rich event stream into a state we care
 *  about at the runner level. */
export type HydraStatus =
  | 'connecting'    // WS not yet open
  | 'idle'          // Greetings received, no head yet
  | 'initializing' // HeadIsInitializing observed
  | 'open'          // HeadIsOpen observed
  | 'closed'        // HeadIsClosed observed (in contestation window)
  | 'finalized'     // HeadIsFinalized observed (terminal happy path)
  | 'aborted'       // HeadIsAborted observed (terminal sad path)
  | 'error';        // WS dropped unrecoverably, or fatal payload

/** Server-output event tags we recognize. Anything else is logged
 *  at debug level and ignored. */
export const RECOGNIZED_TAGS = [
  'Greetings',
  'HeadIsInitializing',
  'Committed',
  'HeadIsOpen',
  'HeadIsClosed',
  'ReadyToFanout',
  'HeadIsFinalized',
  'HeadIsAborted',
  'CommandFailed',
  'PostTxOnChainFailed',
] as const;

export type RecognizedTag = (typeof RECOGNIZED_TAGS)[number];

/** Minimal shape we read from every hydra-node server output.
 *  The real payloads carry far more (timestamps, parties, utxo
 *  snapshots, etc.) but the observer only reads `tag` and uses the
 *  rest opaquely for logging. */
export interface HydraServerOutput {
  tag: string;
  headStatus?: string;     // Present on Greetings
  // The full event is preserved for logging; we never index into it
  // unstructured beyond `tag`.
  [k: string]: unknown;
}

/** Commands we may eventually send (Init, Close, Abort, Fanout, ...).
 *  Slice 1 sends none — we're an observer. Reserved here so the
 *  client interface is shaped right for slice 2. */
export interface HydraClientCommand {
  tag: string;
  [k: string]: unknown;
}