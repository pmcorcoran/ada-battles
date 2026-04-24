# v0.0.1 Grid-Based Hydra PoC

## Overview
This repository contains the v0.0.1 Proof of Concept (PoC) for a decentralized, real-time gaming architecture built on Cardano Hydra. This PoC strips away advanced tokenomics and high-frequency real-time execution to validate the core goal: **using an smart contract(s) as an authoritative referee for off-chain state channel transitions.**

This is a turn-based, 2D grid game running strictly on the Cardano Preprod Testnet and hydra using test ADA (tADA). 

**For the ultimate vision of the project, and the 2 month goal, see 
docs/VISION.md**

## Architecture & Tech Stack
* **Frontend:** TypeScript
* **Smart Contracts:** Aiken
* **Cardano Network:** Preprod Testnet
* **Infrastructure:** Single local `cardano-node` and single local `hydra-node`
* **Networking:** Pure WebSockets connected to the local Hydra Node 
* **Data Payload:** Standard JSON (No WebAssembly or binary compression for this phase)

## Game Mechanics
* **Arena:** 10x10 grid coordinate system.
* **Players:** Supports 3 players.
* **Pacing:** Turn-based.
* **Wager:** Funded purely via Preprod tADA.
* **Win Condition:** Reduce opponent HP to `0`. The final surviving player claims the tADA locked in the Head upon closure.

## The Smart Contract (The Referee)
The core of this PoC is the Aiken validator, which acts as the game server's physics engine and rule enforcer. It evaluates standard JSON-compatible state payloads passed through the Hydra Head.

### The State (Datum)
The UTXO datum inside the Hydra Head represents the entire board state.
```json
{
  "turn": 1,
  "players": [
    {
      "id": 1,
      "pubKey": "ed25519_pub_key_A...",
      "x": 0,
      "y": 0,
      "hp": 3
    },
    {
      "id": 2,
      "pubKey": "ed25519_pub_key_B...",
      "x": 9,
      "y": 9,
      "hp": 3
    }
  ]
}
```

### Actions (Redeemers)
Players submit transactions to the Hydra Head using specific redeemers to alter the state:
- `Move(DeltaX, DeltaY)`: Adjusts the player's X/Y coordinates.
    
- `Shoot(TargetX, TargetY)`: Attacks a specific coordinate on the grid.

### State Validation Rules
The Aiken contract strictly enforces the following rules before allowing a state update in the Head:
- **Turn Authentication:** The transaction signature must match the `pubKey` of the player whose turn it currently is.   
- **Boundaries:** `Move` actions cannot result in X/Y coordinates outside the 10x10 grid (`0` to `9`).   
- **Speed Limits:** A player can only move one tile per turn. Mathematical constraint: `abs(new_x - old_x) + abs(new_y - old_y) <= 1`.  
- **Collision & Damage:** If a `Shoot` coordinate matches an enemy player's X/Y coordinate, the resulting state datum MUST show that enemy's `hp` reduced by exactly `1`.   
- **Turn Progression:** The new state datum MUST correctly increment the `turn` integer.