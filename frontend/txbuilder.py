import os
from dotenv import load_dotenv
from pycardano import (
    PaymentVerificationKey,
    PaymentSigningKey,
    Address, 
    Network, 
    OgmiosChainContext,
    RandomImproveMultiAsset,
    LargestFirstSelector,
    TransactionOutput,
    TransactionBuilder,
    Asset,
    Value,
    AssetName,
    MultiAsset,
    ScriptHash,
    min_lovelace
)

load_dotenv()

# get verification keys and addresses
issuer_vkey = PaymentVerificationKey.load("issuer.vkey")
issuer_address = Address(payment_part=issuer_vkey.hash(), network=Network.TESTNET)
user_vkey = PaymentVerificationKey.load("user.vkey")
user_address = Address(payment_part=user_vkey.hash(), network=Network.TESTNET)

# get context
host = os.environ.get("OGMIOS")
context = OgmiosChainContext(host=host, port=443, secure=True, network = Network.TESTNET)

# policy ud and asset name to send nft
policy_id_from_prim = ScriptHash.from_primitive("a5d1d9a532dae45986d9e3f5b5f65d42355213953f6443330ac962e2")
asset_name_from_func = AssetName(b"VIP_Ticket")

# Get min ada transaction fee
value_to_send = Value(multi_asset=MultiAsset({policy_id_from_prim : Asset({asset_name_from_func: 1})}))
receiver = user_address
output = TransactionOutput(receiver, value_to_send)
min_ada = min_lovelace(context, output)

# create final output usung min ada transaction fee
final_value = Value(min_ada, multi_asset=MultiAsset({policy_id_from_prim : Asset({asset_name_from_func: 1})}))
final_output = TransactionOutput(receiver, final_value)

# get sender signing key
signing_key = PaymentSigningKey.load('../keys/issuer.skey')

# build tx
builder = TransactionBuilder(context, utxo_selectors=[RandomImproveMultiAsset(), LargestFirstSelector()])
builder.add_input_address(issuer_address)
builder.add_output(final_output)

# sign and submit tx
signed_tx = builder.build_and_sign([signing_key], change_address=issuer_address)
context.submit_tx(signed_tx)