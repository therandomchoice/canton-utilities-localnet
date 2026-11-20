IMAGE_TAG := 0.10.3

# Operator party IDs discovered at runtime (see tools/party-ids.sh)
PARTY_IDS_ENV := $(CURDIR)/modules/localnet/.party-ids.env

COMPOSE := IMAGE_TAG=$(IMAGE_TAG) docker compose \
	--env-file $(CURDIR)/modules/localnet/compose.env \
	--env-file $(CURDIR)/modules/localnet/env/common.env \
	--env-file $(PARTY_IDS_ENV) \
	-f $(CURDIR)/modules/localnet/compose.yaml \
	-f $(CURDIR)/modules/localnet/resource-constraints.yaml \
	-f $(CURDIR)/modules/localnet/swagger-ui.yaml \
	--profile sv \
	--profile app-provider \
	--profile app-user \
	--profile swagger-ui

HOSTED_BACKENDS := hosted-backend-sv

.PHONY: up down party-ids vendor-splice openapi

$(PARTY_IDS_ENV):
	@touch $@

up: $(PARTY_IDS_ENV)
	$(COMPOSE) up -d
	@$(MAKE) --no-print-directory party-ids

# Refresh operator party IDs and recreate hosted-backends only if they changed
party-ids: $(PARTY_IDS_ENV)
	@cp $(PARTY_IDS_ENV) $(PARTY_IDS_ENV).prev
	@bash $(CURDIR)/tools/party-ids.sh $(PARTY_IDS_ENV)
	@if ! cmp -s $(PARTY_IDS_ENV) $(PARTY_IDS_ENV).prev; then \
		echo "Operator party IDs changed, recreating hosted-backends"; \
		$(COMPOSE) up -d --no-deps --force-recreate $(HOSTED_BACKENDS); \
	fi
	@rm -f $(PARTY_IDS_ENV).prev

down: $(PARTY_IDS_ENV)
	$(COMPOSE) down

# Upgrade to another Splice release: 3-way merge of upstream cluster/compose/localnet changes.
# Usage: make vendor-splice SPLICE_VERSION=0.10.4
vendor-splice:
	@test -n "$(SPLICE_VERSION)" || { echo "usage: make vendor-splice SPLICE_VERSION=<tag>"; exit 1; }
	@bash $(CURDIR)/tools/vendor-splice.sh $(SPLICE_VERSION)

# Re-collect the OpenAPI specs shown in Swagger UI (after a Splice or hosted-backend upgrade)
openapi:
	@bash $(CURDIR)/tools/openapi.sh
