# ada-battles — dev convenience targets.
#
# N+1 party mesh: `hydra-party-keys` provisions the key POOL that
# DockerOrchestrator mounts into every per-match hydra-node. It replaces
# the old single-bundle `hydra-dev-keys` target (offline-mode era).
#
# After generating, you MUST:
#   1. Put your Blockfrost preprod project id in
#      infra/hydra-parties/shared/blockfrost-project.txt
#   2. Fund every party fuel address on preprod (each node pays its own
#      L1 fees from it). `make hydra-party-addresses` prints them for
#      the faucet: https://docs.cardano.org/cardano-testnets/tools/faucet
#
# These are FUEL keys generated and owned by the operator — they are
# not player wallet keys and never sign game moves. Do not commit them:
# infra/hydra-parties/ belongs in .gitignore.

HYDRA_IMG     ?= ghcr.io/cardano-scaling/hydra-node:2.0.0
HYDRA_VERSION ?= 2.0.0
# Hydra ships a ready-made zero-fee protocol-parameters.json in its repo
# (a copy of mainnet params with fees nullified) — what the L2 ledger
# wants. Pinned to the same tag as the node image. NOTE: zero
# utxoCostPerByte means L2 accepts dust outputs, but FANOUT is an L1 tx
# under real preprod rules — keep ~2 ada on every L2 UTxO you create.
HYDRA_PP_URL  ?= https://raw.githubusercontent.com/cardano-scaling/hydra/$(HYDRA_VERSION)/hydra-cluster/config/protocol-parameters.json

# Party pool size. MAX_PLAYERS is 3..5, so the worst case needs
# maxPlayers + 1 = 6 dirs (p0 = referee, p1..p5 = player slots).
PARTIES ?= 6
POOL    ?= infra/hydra-parties

.PHONY: hydra-party-keys
hydra-party-keys:
	@echo "==> provisioning $(PARTIES)-party key pool under $(POOL)/"
	mkdir -p $(POOL)/shared
	@for i in $$(seq 0 $$(( $(PARTIES) - 1 ))); do \
	  d=$(POOL)/parties/p$$i; \
	  mkdir -p $$d; \
	  if [ ! -f $$d/hydra.sk ]; then \
	    echo "==> [p$$i] generating hydra keypair"; \
	    docker run --rm -v "$$PWD/$$d:/k" $(HYDRA_IMG) \
	      gen-hydra-key --output-file /k/hydra; \
	  fi; \
	  if [ ! -f $$d/cardano.sk ]; then \
	    echo "==> [p$$i] generating cardano (fuel) keypair"; \
	    cardano-cli address key-gen \
	      --verification-key-file $$d/cardano.vk \
	      --signing-key-file     $$d/cardano.sk; \
	  fi; \
	done
	# If cardano-cli isn't installed locally, run the loop body via a
	# dockerized cardano-cli instead, mounting $(POOL) the same way the
	# hydra keygen above does.
	@echo "==> fetching zero-fee protocol parameters from hydra $(HYDRA_VERSION)"
	curl -fsSL $(HYDRA_PP_URL) \
	  -o $(POOL)/shared/protocol-parameters.json
	@test -f $(POOL)/shared/blockfrost-project.txt \
	  || echo "!!  $(POOL)/shared/blockfrost-project.txt is MISSING — create it"
	@echo "==> done. Pool contents:"
	@ls -laR $(POOL)/

.PHONY: hydra-party-addresses
hydra-party-addresses:
	@echo "==> party fuel addresses (fund each on preprod):"
	@for vk in $(POOL)/parties/p*/cardano.vk; do \
	  printf '%s  ' $$vk; \
	  cardano-cli address build --testnet-magic 1 \
	    --payment-verification-key-file $$vk; \
	  echo; \
	done