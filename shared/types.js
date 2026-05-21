/**
 * Shared Type Definitions
 *
 * Strongly-typed contract between server payloads and client consumers.
 * Every WebSocket message conforms to one of the event maps below,
 * preventing silent deserialization bugs.
 */
/** Sentinel for "no slot / null winner" in u8 slot fields. Slots 0–6 are valid. */
export const NO_SLOT = 0xFF;
