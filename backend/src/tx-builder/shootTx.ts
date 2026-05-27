import { LucidEvolution, UTxO, Constr, SpendingValidator, Data } from "@lucid-evolution/lucid";
import { 
  POSITION_VALIDATOR_CBOR, 
  BULLETS_VALIDATOR_ADDRESS ,
  BULLETS_VALIDATOR_CBOR,
  BULLET_FLIGHT_PER_CHECKPOINT,
  MUZZLE_OFFSET,
  DIR_SCALE
} from './constants';


interface Bullet {
  owner: string;
  is_active: boolean;
  x: bigint;
  y: bigint;
  dir_x: bigint;
  dir_y: bigint;
}

export async function submitBulletsTransaction(
  lucid: LucidEvolution,
  currentBulletsUtxo: UTxO,
  playerPositionUtxo: UTxO, // Required as a reference input to calculate muzzle offset!
  isShooting: boolean,
  currentCheckpoint: bigint,
  aimDirX: bigint = 0n,
  aimDirY: bigint = 0n,
  ownerPubKeyHash: string
) {
    
    if (!currentBulletsUtxo.datum || !playerPositionUtxo.datum) {
    throw new Error("Missing datum on required UTxOs");
  }

  // Parse Bullets Datum
  // Constr(0, [owner, bulletsList, last_shot_checkpoint, last_flight_checkpoint])
  const rawBulletsDatum = Data.from(currentBulletsUtxo.datum) as Constr<any>;
  const oldBulletsList = rawBulletsDatum.fields[1] as Constr<any>[];
  const oldLastShotCheckpoint = rawBulletsDatum.fields[2] as bigint;

  // Map Plutus Constr array into workable JS Objects
  const currentBullets: Bullet[] = oldBulletsList.map(b => ({
    owner: b.fields[0] as string,
    is_active: b.fields[1] === 1n,
    x: b.fields[2] as bigint,
    y: b.fields[3] as bigint,
    dir_x: b.fields[4] as bigint,
    dir_y: b.fields[5] as bigint,
  }));

  // CALCULATE MUZZLE OFFSET IF SHOOTING
  let muzzleX = 0n;
  let muzzleY = 0n;

  if (isShooting) {
    // Parse Position Datum to find where the player currently is
    // Constr(0, [owner, x, y, alive, last_move_checkpoint])
    const posDatum = Data.from(playerPositionUtxo.datum) as Constr<any>;
    const playerX = posDatum.fields[1] as bigint;
    const playerY = posDatum.fields[2] as bigint;

    // Apply the exact same offset math as the Opshin contract
    muzzleX = playerX + (aimDirX * MUZZLE_OFFSET) / DIR_SCALE;
    muzzleY = playerY + (aimDirY * MUZZLE_OFFSET) / DIR_SCALE;
  }

  // RUN THE FLIGHT/SPAWN MATH HELPER
  const nextBulletsArray = calculateNextBullets(
    currentBullets, 
    isShooting, 
    muzzleX, 
    muzzleY, 
    aimDirX, 
    aimDirY
  );

  // RE-ENCODE BACK TO PLUTUS DATA
  // map the JS objects back into an array of Plutus Constr objects
  const plutusBulletsArray = nextBulletsArray.map(b => 
    new Constr(0, [
      b.owner,
      b.is_active ? 1n : 0n, // Opshin boolean format
      b.x,
      b.y,
      b.dir_x,
      b.dir_y
    ])
  );

  const newLastShotCheckpoint = isShooting ? currentCheckpoint : oldLastShotCheckpoint;

  const newBulletsDatum = Data.to(new Constr(0, [
    ownerPubKeyHash,
    plutusBulletsArray, // The properly formatted Plutus List
    newLastShotCheckpoint,
    currentCheckpoint   // Updates last_flight_checkpoint unconditionally
  ]));

  const shootRedeemer = Data.to(new Constr(0, [
    isShooting ? 1n : 0n, 
    aimDirX,
    aimDirY,
    currentCheckpoint
  ]));

  const bulletsValidator: SpendingValidator = {
    type: "PlutusV3",
    script: BULLETS_VALIDATOR_CBOR
  };

  const tx = await lucid
    .newTx()
    .collectFrom([currentBulletsUtxo], shootRedeemer)
    .readFrom([playerPositionUtxo]) 
    .attach.SpendingValidator(bulletsValidator)
    .pay.ToContract(
      BULLETS_VALIDATOR_ADDRESS,
      { kind: "inline", value: newBulletsDatum },
      { lovelace: 10_000_000n }
    )
    .addSignerKey(ownerPubKeyHash)
    .complete({ localUPLCEval: false });

  const signedTx = await tx.sign.withWallet().complete();
  return await signedTx.submit();
}


/**
 * Calculates the new state of the bullet array.
 * Advances all currently active bullets by one flight step.
 * If isShooting is true, activates one inactive bullet at the muzzle.
 */
function calculateNextBullets(
  currentBullets: Bullet[], 
  isShooting: boolean,
  muzzleX: bigint,
  muzzleY: bigint,
  aimDirX: bigint,
  aimDirY: bigint
): Bullet[] {
  
  const newBullets = currentBullets.map(bullet => {
    // 1. Advance bullets that are already flying
    if (bullet.is_active) {
      return {
        ...bullet,
        x: bullet.x + (bullet.dir_x * BULLET_FLIGHT_PER_CHECKPOINT) / DIR_SCALE,
        y: bullet.y + (bullet.dir_y * BULLET_FLIGHT_PER_CHECKPOINT) / DIR_SCALE,
      };
    }
    return { ...bullet }; // Return a clone to avoid mutating the original
  });

  // 2. If shooting, find the first inactive bullet and spawn it
  if (isShooting) {
    const freeSlotIndex = newBullets.findIndex(b => !b.is_active);
    if (freeSlotIndex !== -1) {
      newBullets[freeSlotIndex] = {
        owner: currentBullets[0].owner,
        is_active: true,
        x: muzzleX,
        y: muzzleY,
        dir_x: aimDirX,
        dir_y: aimDirY,
      };
    } else {
      console.warn("Attempted to shoot, but no inactive bullets are available.");
    }
  }

  return newBullets;
}