# ada-battles — dev convenience targets.
#
# Slice 1 added the hydra-dev-keys target; everything else is for
# future use.

HYDRA_IMG     ?= ghcr.io/cardano-scaling/hydra-node:1.2.0
HYDRA_VERSION ?= 1.2.0
# Hydra ships a ready-made zero-fee protocol-parameters.json in its repo
# (a copy of mainnet params with fees nullified) — exactly what offline
# mode wants. Pinned to the same tag as the node image.
HYDRA_PP_URL  ?= https://raw.githubusercontent.com/cardano-scaling/hydra/$(HYDRA_VERSION)/hydra-cluster/config/protocol-parameters.json

.PHONY: hydra-dev-keys
hydra-dev-keys:
	@echo "==> generating hydra keypair into infra/hydra-dev-keys/"
	docker run --rm \
	  -v "$$PWD/infra/hydra-dev-keys:/keys" \
	  $(HYDRA_IMG) \
	  gen-hydra-key --output-file /keys/hydra
	@echo "==> fetching zero-fee protocol parameters from hydra $(HYDRA_VERSION)"
	curl -fsSL $(HYDRA_PP_URL) \
	  -o infra/hydra-dev-keys/protocol-parameters.json
	@echo "==> ensuring initial-utxo.json (seed UTxO from hydra docs)"
	@test -f infra/hydra-dev-keys/initial-utxo.json || printf '%s\n' \
	  '{' \
	  '  "0000000000000000000000000000000000000000000000000000000000000000#0": {' \
	  '    "address": "addr_test1vp5cxztpc6hep9ds7fjgmle3l225tk8ske3rmwr9adu0m6qchmx5z",' \
	  '    "value": { "lovelace": 100000000 }' \
	  '  }' \
	  '}' > infra/hydra-dev-keys/initial-utxo.json
	@echo "==> done. Bundle contents:"
	@ls -la infra/hydra-dev-keys/