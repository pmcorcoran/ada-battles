import { 
  Lucid, 
  UTxO, 
  Data, 
  Constr, 
  SpendingValidator, 
  LucidEvolution
} from '@lucid-evolution/lucid';
import { 
  POSITION_VALIDATOR_CBOR, 
  POSITION_VALIDATOR_ADDRESS 
} from './constants';

/**
 * Builds, signs, and submits a player movement transaction.
 * @param lucid - An already initialized Lucid instance with the player's wallet selected.
 * @param currentPositionUtxo - The exact UTxO being spent (cached from the WebSocket).
 * @param healthUtxo - The reference Health UTxO.
 * @param newPositionDatum - The compiled Plutus Data string for the new coordinates.
 * @param playerPubKeyHash - The active wallet's public key hash.
 * @returns The transaction hash.
 */
export async function submitMoveTransaction(
  lucid: LucidEvolution,
  currentPositionUtxo: UTxO,
  healthUtxo: UTxO,
  newPositionDatum: string, 
  playerPubKeyHash: string
): Promise<string> {
  
  const moveValidator: SpendingValidator = {
    type: "PlutusV3", // Ensure this matches your Opshin compilation target (V2 or V3)
    script: POSITION_VALIDATOR_CBOR,
  }; 

  // Hardcoded standard move redeemer (adjust if your redeemer requires arguments)
  const moveRedeemer = Data.to(new Constr(0, [])); //might need "checkpoint"

  const tx = await lucid
    .newTx()
    .collectFrom([currentPositionUtxo], moveRedeemer)
    .readFrom([healthUtxo])
    .attach.SpendingValidator(moveValidator) 
    .pay.ToContract(
      POSITION_VALIDATOR_ADDRESS,
      {
        kind: "inline",
        value: newPositionDatum
      },
      { lovelace: 10_000_000n } // The MinADA locked in the state
    )
    .addSignerKey(playerPubKeyHash)
    // Skips local WebAssembly evaluation for instant generation
    .complete({ localUPLCEval: false }); 

  const signedTx = await tx.sign.withWallet().complete();
  const txHash = await signedTx.submit();
  
  return txHash;
}