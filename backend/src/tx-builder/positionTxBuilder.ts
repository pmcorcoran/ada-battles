import { Lucid, Emulator, Data, Constr , SpendingValidator} from '@lucid-evolution/lucid';
import { POSITION_VALIDATOR_CBOR, POSITION_VALIDATOR_ADDRESS, HEALTH_VALIDATOR_ADDRESS } from './constants';


const provider = new Emulator([]);
const lucid = await Lucid(provider, "Preprod");


let PositionUtxos = await lucid.utxosAt(POSITION_VALIDATOR_ADDRESS);
let healthUtxos = await lucid.utxosAt(HEALTH_VALIDATOR_ADDRESS);

let currentPositionUtxo = PositionUtxos[0];
let healthUtxo = healthUtxos[0];

const moveValidator: SpendingValidator = {
    type: "PlutusV3",
    script: POSITION_VALIDATOR_CBOR,
}; 

const moveRedeemer = Data.to(new Constr(0, []));// figure out how to dynamically create redeemer
const newPositionDatum = Data.to(new Constr(0, [])); // figure out how to create datum from input

const playerPubKeyHash = "fjdfdjk"; // get it from wallet

const tx = await lucid
  .newTx()
  .collectFrom([currentPositionUtxo], moveRedeemer)
  .readFrom([healthUtxo])
  .attach.SpendingValidator(moveValidator) // Provide the actual script logic
  .pay.ToContract(POSITION_VALIDATOR_ADDRESS,
    {
        kind: "inline",
        value: newPositionDatum
    },
    {lovelace: 10_000_000n}
)
  .addSignerKey(playerPubKeyHash)
  .complete();

const signedTx = await tx.sign.withWallet().complete();
const txHash = await signedTx.submit();