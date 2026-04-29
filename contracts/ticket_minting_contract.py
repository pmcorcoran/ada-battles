from opshin.prelude import *

# --- define the possible actions for the redeemer ---
@dataclass()
class MintTicket(PlutusData):
    CONSTR_ID = 0

@dataclass()
class BurnTicket(PlutusData):
    CONSTR_ID = 1

TicketAction = Union[MintTicket, BurnTicket]


# --- create the validator ---
def validator(issuer_vkey: bytes, context: ScriptContext) -> None:
    redeemer: TicketAction = context.redeemer
    tx_info = context.transaction
    purpose = context.purpose

    # --- assert purpose is class Minting ---
    assert isinstance(purpose, Minting), "Script must be used as a minting policy"
    own_policy_id = purpose.policy_id

    is_minting = False
    is_burning = False

    total_amount = 0
    for policy_id, token_dict in tx_info.mint.items():
        if policy_id == own_policy_id:
            # Iterate through the specific assets
            for asset_name, amount in token_dict.items():
                if amount > 0:
                    is_minting = True
                elif amount < 0:
                    is_burning = True
    

    # --- Minting ---
    if isinstance(redeemer, MintTicket):
        assert issuer_vkey in tx_info.signatories, "Only the studio can authorize creation of new tickets"
        assert is_minting, "Mint amount must be positive"
        assert not is_burning, "Cannot burn tickets during a minting transaction"
        assert total_amount < 4, "Cannot mint more than 3 tickets at once."

    # --- Burning ---
    elif isinstance(redeemer, BurnTicket):
        assert is_burning, "Burn amount must be negative"
        assert not is_minting, "CRITICAL: Cannot mint any tickets during a burn!"
        
    else:
        # Explicitly fail if a weird redeemer is passed instead of using 'pass'
        assert False, "Invalid redeemer provided"