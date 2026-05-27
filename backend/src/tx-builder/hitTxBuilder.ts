import { LucidEvolution, UTxO, Constr, SpendingValidator, Data } from "@lucid-evolution/lucid";
import { 
  BULLETS_VALIDATOR_ADDRESS,
  HEALTH_VALIDATOR_ADDRESS,
  BULLETS_VALIDATOR_CBOR,
  HEALTH_VALIDATOR_CBOR
} from './constants';



export async function submitHitTransaction(
  lucid: LucidEvolution,
  shooterBulletsUtxo: UTxO,      // The shooter's bullets (to deactivate the landing bullet)
  victimHealthUtxo: UTxO,        // The victim's health (to subtract 1 HP)
  victimPositionUtxo: UTxO,      // Reference input to prove the geometry
  bulletIndex: bigint,           // Which bullet in the array hit them
  shooterPubKeyHash: string,
  //victimPubKeyHash: string,
  currentCheckpoint: bigint
) {

    if (!shooterBulletsUtxo.datum || !victimHealthUtxo.datum) {
    throw new Error("Missing datum on required UTxOs");
  }

  //  EXTRACT DATUMS
  // ... Parse the shooter's bullet array and set the hitting bullet's is_active to false.
  const shooterBulletsDatum = Data.from(shooterBulletsUtxo.datum) as Constr<any>;
  const shooterBulletsFields = shooterBulletsDatum.fields;
  const bulletsOwner = shooterBulletsFields[0] as string;
  const oldBulletsArray = shooterBulletsFields[1] as Constr<any>[];
  const lastShotCheckpoint = shooterBulletsFields[2] as bigint;
  const lastFlightCheckpoint = shooterBulletsFields[3] as bigint;

  const newBulletsArray = [...oldBulletsArray];
  const hitBulletConstr = newBulletsArray[Number(bulletIndex)];
  const hbFields = hitBulletConstr.fields;

  // Re-encode that specific bullet with `is_active` set to 0n (False)
  newBulletsArray[Number(bulletIndex)] = new Constr(0, [
    hbFields[0], // owner
    0n,          // is_active = False (Bullet destroyed!)
    hbFields[2], // x
    hbFields[3], // y
    hbFields[4], // dir_x
    hbFields[5]  // dir_y
  ]);

  // ... Parse the victim's health datum and subtract 1. (Check if it hits 0 for elimination!)
  const victimHealthDatum = Data.from(victimHealthUtxo.datum) as Constr<any>;
  const hFields = victimHealthDatum.fields;
  const healthOwner = hFields[0] as string;
  const currentHealth = hFields[1] as bigint;
  let eliminatedBy = hFields[2] as string;
  let diedAtCheckpoint = hFields[3] as bigint;

  // Apply the HIT_DAMAGE (1)
  const newHealth = currentHealth - 1n;

  // Check for Elimination
  if (newHealth <= 0n) {
    eliminatedBy = shooterPubKeyHash;    // Record the killer
    diedAtCheckpoint = currentCheckpoint; // Record the time of death
  }


  // ENCODE THE NEW DATUMS
  const newBulletsDatum = Data.to(new Constr(0, [
    bulletsOwner,
    newBulletsArray, // Now contains the deactivated bullet
    lastShotCheckpoint,
    lastFlightCheckpoint
  ]));

  const newHealthDatum = Data.to(new Constr(0, [
    healthOwner,
    newHealth < 0n ? 0n : newHealth, // Safety clamp to prevent negative HP
    eliminatedBy,
    diedAtCheckpoint
  ]));

  // 3. ENCODE THE REDEEMERS
  // The HitInput redeemer for the Health contract
  const healthHitRedeemer = Data.to(new Constr(0, [
    bulletIndex,
    shooterPubKeyHash, 
    currentCheckpoint
  ]));

  // The flight/shoot redeemer for the Bullets contract (is_shooting = false)
  const bulletsRedeemer = Data.to(new Constr(0, [
    0n, // is_shooting = False
    0n, 0n, // Dummy aim dirs
    currentCheckpoint
  ]));

  // 4. LOAD BOTH VALIDATORS
  const bulletsValidator: SpendingValidator = { type: "PlutusV3", script: BULLETS_VALIDATOR_CBOR };
  const healthValidator: SpendingValidator = { type: "PlutusV3", script: HEALTH_VALIDATOR_CBOR };

  // 5. BUILD THE MULTI-VALIDATOR TX
  const tx = await lucid
    .newTx()
    
    // Spend the shooter's bullet
    .collectFrom([shooterBulletsUtxo], bulletsRedeemer)
    .attach.SpendingValidator(bulletsValidator)
    .pay.ToContract(
      BULLETS_VALIDATOR_ADDRESS,
      { kind: "inline", value: newBulletsDatum },
      { lovelace: 0n }
    )

    // Spend the victim's health
    .collectFrom([victimHealthUtxo], healthHitRedeemer)
    .attach.SpendingValidator(healthValidator)
    .pay.ToContract(
      HEALTH_VALIDATOR_ADDRESS,
      { kind: "inline", value: newHealthDatum },
      { lovelace: 0n } // Or whatever MinADA is required
    )

    // Prove the victim was actually standing there
    .readFrom([victimPositionUtxo]) 

    // ONLY the shooter signs this (Shooter-asserted damage)
    .addSignerKey(shooterPubKeyHash) 
    .complete({ localUPLCEval: false });

  const signedTx = await tx.sign.withWallet().complete();
  return await signedTx.submit();
}