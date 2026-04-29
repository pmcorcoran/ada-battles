import pytest
import time
import os
from dotenv import load_dotenv
from dataclasses import dataclass
from pycardano import (
    TransactionBuilder,
    TransactionOutput,
    ExecutionUnits,
    PlutusData,
    Address,
    Network,
    PaymentSigningKey,
    PaymentVerificationKey,
    AssetName,
    MultiAsset,
    Value,
    Redeemer,
    plutus_script_hash,
    BlockFrostChainContext
)
from opshin.builder import build
load_dotenv()

# --- REDEEMERS ---
@dataclass
class MintTicket(PlutusData):
    CONSTR_ID = 0

@dataclass
class BurnTicket(PlutusData):
    CONSTR_ID = 1

# --- FIXTURES ---

@pytest.fixture
def context():
    """Connects to the Blockfrost API"""
    
    # Grab the URL and API Key from the environment
    #demeter_url = os.environ.get("OMGIOS_AUTH_URL")
    #api_key = os.environ.get("OMGIOS_API_KEY")
    api_key = os.getenv("BLOCKFROST_API_KEY")
    return BlockFrostChainContext(project_id=api_key, network=Network.TESTNET)
    

def load_wallet(name: str):
    """Helper to load a real wallet from the file system."""
    skey = PaymentSigningKey.load(f"test-keys/{name}.skey")
    vkey = PaymentVerificationKey.load(f"test-keys/{name}.vkey")
    address = Address(payment_part=vkey.hash(), network=Network.TESTNET)
    return skey, vkey, address

@pytest.fixture
def issuer():
    # Make sure keys/issuer.skey exists and is funded with testnet ADA
    return load_wallet("issuer")

@pytest.fixture
def user():
    # Make sure keys/user.skey exists and is funded with testnet ADA
    return load_wallet("user")

@pytest.fixture
def compiled_policy(issuer):
    """Compiles the contract parameterized with the issuer's Verification Key Hash."""
    _, issuer_vkey, _ = issuer
    issuer_vkey_hash = issuer_vkey.hash().payload
    
    # 1. OpShin's build() now natively returns the PlutusV3Script object!
    script = build("../ticket_minting_contract.py", issuer_vkey_hash)
    
    # 2. Safely calculate the Policy ID using PyCardano's script hashing utility
    policy_id = plutus_script_hash(script)
    
    return script, policy_id

# --- THE TEST ---

def test_successful_minting_with_blockfrost(context, issuer, user, compiled_policy):
    """Mints tickets on a live network via Ogmios."""
    issuer_skey, issuer_vkey, issuer_addr = issuer
    _, _, user_addr = user
    script, policy_id = compiled_policy
    mint_amount=1
    asset_name = AssetName(b"VIP_Ticket")
    mint_val = MultiAsset.from_primitive({
        policy_id.payload: {asset_name.payload: mint_amount}
    })

    # 1. Build the transaction using the Ogmios Context
    builder = TransactionBuilder(context)
    
    # ADD THIS LINE: Tell the builder to use the Issuer's wallet to pay for fees
    builder.add_input_address(issuer_addr)
    
    # (Optional: If using the hardcoded ex_units fix)
    redeemer = Redeemer(MintTicket(), ex_units=ExecutionUnits(10_000_000, 3_000_000_000)) 
    
    builder.add_minting_script(script, redeemer)
    builder.mint = mint_val
    
    # This requires 2 ADA (2_000_000 lovelace). The builder will pull this from the issuer_addr
    builder.add_output(TransactionOutput(user_addr, Value(2_000_000, mint_val)))
    
    builder.required_signers = [issuer_vkey.hash()]

    # 2. Build, Sign, and Submit
    tx = builder.build_and_sign([issuer_skey], change_address=issuer_addr)
    
    
    
    tx_id = tx.transaction_body.hash()
    print(f"\nSubmitting Tx: {tx_id.hex()}")
    context.submit_tx(tx)

    # 3. Poll for confirmation, scoped to THIS transaction's output at user_addr
    print("Waiting for transaction to be confirmed on-chain...")
    max_retries = 30
    sleep_seconds = 10
    confirmed = False

    policy_id_bytes = policy_id.payload
    asset_name_bytes = asset_name.payload
    
    def utxo_holds_tickets(u):
        if bytes(u.input.transaction_id) != tx_id:
            return False
        ma = u.output.amount.multi_asset
        if not ma:
            return False
        for pid, assets in ma.items():
            if pid.payload == policy_id_bytes:
                for an, qty in assets.items():
                    if an.payload == asset_name_bytes and qty >= mint_amount:
                        return True
        return False

    for i in range(max_retries):
        time.sleep(sleep_seconds)
        user_utxos = context.utxos(user_addr)
        print(f"  Attempt {i+1}/{max_retries}: {len(user_utxos)} UTxOs at user_addr")

        if any(utxo_holds_tickets(u) for u in user_utxos):
            confirmed = True
            print("Transaction confirmed!")
            break

            
    assert confirmed, "Transaction was submitted but not confirmed within the timeout."



def test_fail_minting_zero_tickets(context, issuer, user, compiled_policy):
    """Expect failure when attempting to mint 0 tickets."""
    issuer_skey, issuer_vkey, issuer_addr = issuer
    _, _, user_addr = user
    script, policy_id = compiled_policy
    
    asset_name = AssetName(b"VIP_Ticket")
    
    # BAD CASE: Amount is 0
    mint_val = MultiAsset.from_primitive({
        policy_id.payload: {asset_name.payload: 0}
    })

    builder = TransactionBuilder(context)
    builder.add_input_address(issuer_addr)
    
    redeemer = Redeemer(MintTicket(), ex_units=ExecutionUnits(10_000_000, 3_000_000_000)) 
    builder.add_minting_script(script, redeemer)
    builder.mint = mint_val
    builder.required_signers = [issuer_vkey.hash()]

    # We expect an exception because the contract requires a positive amount
    with pytest.raises(Exception) as exc_info:
        tx = builder.build_and_sign([issuer_skey], change_address=issuer_addr)
        context.submit_tx(tx)
    
    print(f"\nSuccessfully caught expected failure: {exc_info.type}")



def test_fail_unauthorized_minting(context, user, compiled_policy):
    """Expect failure when a standard user tries to mint without the issuer's signature."""
    user_skey, user_vkey, user_addr = user
    script, policy_id = compiled_policy
    
    asset_name = AssetName(b"VIP_Ticket")
    mint_val = MultiAsset.from_primitive({
        policy_id.payload: {asset_name.payload: 10}
    })

    builder = TransactionBuilder(context)
    builder.add_input_address(user_addr) # User is paying for this tx
    
    redeemer = Redeemer(MintTicket(), ex_units=ExecutionUnits(10_000_000, 3_000_000_000)) 
    builder.add_minting_script(script, redeemer)
    builder.mint = mint_val
    
    # BAD CASE: Missing the issuer's required signer hash
    builder.required_signers = [user_vkey.hash()]

    # We expect an exception because the script won't find issuer_vkey in signatories
    with pytest.raises(Exception):
        # Signed only by the user
        tx = builder.build_and_sign([user_skey], change_address=user_addr)
        context.submit_tx(tx)





def test_fail_mint_and_burn_together_mint_redeemer(context, issuer, compiled_policy):
    """Expect failure when minting and burning simultaneously using the MintTicket redeemer."""
    issuer_skey, issuer_vkey, issuer_addr = issuer
    script, policy_id = compiled_policy
    
    mint_asset = AssetName(b"VIP_Ticket")
    burn_asset = AssetName(b"Old_Ticket")
    
    # BAD CASE: Dictionary contains both positive and negative values
    mint_val = MultiAsset.from_primitive({
        policy_id.payload: {
            mint_asset.payload: 5,
            burn_asset.payload: -5
        }
    })

    builder = TransactionBuilder(context)
    builder.add_input_address(issuer_addr)
    
    # Passing the Minting Redeemer
    redeemer = Redeemer(MintTicket(), ex_units=ExecutionUnits(10_000_000, 3_000_000_000)) 
    builder.add_minting_script(script, redeemer)
    builder.mint = mint_val
    builder.required_signers = [issuer_vkey.hash()]

    # Expect failure: "Cannot burn tickets during a minting transaction"
    with pytest.raises(Exception):
        tx = builder.build_and_sign([issuer_skey], change_address=issuer_addr)
        context.submit_tx(tx)


def test_fail_mint_and_burn_together_burn_redeemer(context, issuer, compiled_policy):
    """Expect failure when minting and burning simultaneously using the BurnTicket redeemer."""
    issuer_skey, issuer_vkey, issuer_addr = issuer
    script, policy_id = compiled_policy
    
    mint_asset = AssetName(b"VIP_Ticket")
    burn_asset = AssetName(b"Old_Ticket")
    
    # BAD CASE: Dictionary contains both positive and negative values
    mint_val = MultiAsset.from_primitive({
        policy_id.payload: {
            mint_asset.payload: 5,
            burn_asset.payload: -5
        }
    })

    builder = TransactionBuilder(context)
    builder.add_input_address(issuer_addr)
    
    # Passing the Burning Redeemer
    redeemer = Redeemer(BurnTicket(), ex_units=ExecutionUnits(10_000_000, 3_000_000_000)) 
    builder.add_minting_script(script, redeemer)
    builder.mint = mint_val

    # Expect failure: "CRITICAL: Cannot mint any tickets during a burn!"
    with pytest.raises(Exception):
        tx = builder.build_and_sign([issuer_skey], change_address=issuer_addr)
        context.submit_tx(tx)





# Add this mock redeemer at the top of your test file near the others
@dataclass
class FakeAction(PlutusData):
    CONSTR_ID = 2  # Not recognized by your OpShin script

def test_fail_invalid_redeemer(context, issuer, compiled_policy):
    """Expect failure when passing an unknown redeemer to the contract."""
    issuer_skey, issuer_vkey, issuer_addr = issuer
    script, policy_id = compiled_policy
    
    asset_name = AssetName(b"VIP_Ticket")
    mint_val = MultiAsset.from_primitive({
        policy_id.payload: {asset_name.payload: 1}
    })

    builder = TransactionBuilder(context)
    builder.add_input_address(issuer_addr)
    
    # BAD CASE: Using the FakeAction redeemer
    redeemer = Redeemer(FakeAction(), ex_units=ExecutionUnits(10_000_000, 3_000_000_000)) 
    builder.add_minting_script(script, redeemer)
    builder.mint = mint_val
    builder.required_signers = [issuer_vkey.hash()]

    # Expect failure: "Invalid redeemer provided"
    with pytest.raises(Exception):
        tx = builder.build_and_sign([issuer_skey], change_address=issuer_addr)
        context.submit_tx(tx)


def test_fail_minting_over_limit(context, issuer, compiled_policy):
    """Expect failure when attempting to mint more than 3 tickets."""
    issuer_skey, issuer_vkey, issuer_addr = issuer
    script, policy_id = compiled_policy
    
    asset_name = AssetName(b"VIP_Ticket")
    
    # BAD CASE: Amount is 4 (over the limit of 3)
    mint_val = MultiAsset.from_primitive({
        policy_id.payload: {asset_name.payload: 4}
    })

    builder = TransactionBuilder(context)
    builder.add_input_address(issuer_addr)
    
    redeemer = Redeemer(MintTicket(), ex_units=ExecutionUnits(10_000_000, 3_000_000_000)) 
    builder.add_minting_script(script, redeemer)
    builder.mint = mint_val
    builder.required_signers = [issuer_vkey.hash()]

    # We expect an exception because the contract caps the total_minted at 3
    with pytest.raises(Exception) as exc_info:
        tx = builder.build_and_sign([issuer_skey], change_address=issuer_addr)
        context.submit_tx(tx)
        
    print(f"\nSuccessfully caught expected limit failure: {exc_info.type}")


def test_successful_minting_user_pays(context, issuer, user, compiled_policy):
    """
    User funds the transaction (their UTxOs are spent for fees and min-ADA),
    while the issuer co-signs to satisfy the contract's authorization check.
    """
    issuer_skey, issuer_vkey, _ = issuer
    user_skey, user_vkey, user_addr = user
    script, policy_id = compiled_policy

    asset_name = AssetName(b"VIP_Ticket")
    mint_amount = 1
    mint_val = MultiAsset.from_primitive({
        policy_id.payload: {asset_name.payload: mint_amount}
    })

    # 1. Build the transaction with the USER as the input/fee payer
    builder = TransactionBuilder(context)
    builder.add_input_address(user_addr)

    redeemer = Redeemer(MintTicket(), ex_units=ExecutionUnits(10_000_000, 3_000_000_000))
    builder.add_minting_script(script, redeemer)
    builder.mint = mint_val

    builder.add_output(TransactionOutput(user_addr, Value(2_000_000, mint_val)))

    builder.required_signers = [issuer_vkey.hash(), user_vkey.hash()]

    # 2. Co-sign and submit
    tx = builder.build_and_sign(
        [issuer_skey, user_skey],
        change_address=user_addr,
    )

    tx_id = tx.transaction_body.hash()
    print(f"\nSubmitting Tx: {tx_id.hex()}")
    context.submit_tx(tx)

    # 3. Poll for confirmation, scoped to THIS transaction's output at user_addr
    print("Waiting for transaction to be confirmed on-chain...")
    max_retries = 5
    sleep_seconds = 20
    confirmed = False

    # --- NEW: bytes-based matching helper ---
    policy_id_bytes = policy_id.payload
    asset_name_bytes = asset_name.payload

    def utxo_holds_tickets(u):
        if bytes(u.input.transaction_id) != tx_id:
            return False
        ma = u.output.amount.multi_asset
        print(ma)
        if not ma:
            return False
        for pid, assets in ma.items():
            if pid.payload == policy_id_bytes:
                for an, qty in assets.items():
                    if an.payload == asset_name_bytes and qty >= mint_amount:
                        return True
        return False
    # --- END NEW ---

    for i in range(max_retries):
        user_utxos = context.utxos(user_addr)
        print(f"  Attempt {i+1}/{max_retries}: {len(user_utxos)} UTxOs at user_addr")

        # --- CHANGED: use the helper instead of the inline predicate ---
        holds_tickets = any(utxo_holds_tickets(u) for u in user_utxos)

        if holds_tickets:
            confirmed = True
            print("Transaction confirmed!")
            break
        time.sleep(sleep_seconds)

    assert confirmed, "Transaction was submitted but not confirmed within the timeout."