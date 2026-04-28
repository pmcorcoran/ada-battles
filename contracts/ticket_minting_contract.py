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

    
    total_amount = 0
    for policy_id, token_dict in tx_info.mint.items():
        
        if policy_id == own_policy_id:
            
            # Iterate through the specific assets and tally the amount
            for asset_name, amount in token_dict.items():
                total_amount += amount
    

    # --- Minting ---
    if isinstance(redeemer, MintTicket):
        assert issuer_vkey in tx_info.signatories, "Only the studio can authorize creation of new tickets"
        assert total_amount > 0, "Mint amount must be positive"

    # --- Burning ---
    elif isinstance(redeemer, BurnTicket):
        assert total_amount < 0, "Burn amount must be negative"
    else:
        assert False, "Invalid redeemer provided"
        