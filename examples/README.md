# Examples

TypeScript examples against the running localnet (`make up`). They have no runtime dependencies:
Node.js 22.18+ runs `.ts` files directly and provides `fetch`.

```bash
node amulet-transfer.ts
node utilities-token-transfer.ts [INSTRUMENT_ID]   # default DEMO

npm install && npm run typecheck                   # optional: type-check with tsc
```

Both examples use the two validator parties: **app-provider** (sender) and **app-user** (receiver).
The Utilities example also uses the **utility-operator** party on the sv participant.
Authentication is the localnet HS256 JWT with secret `unsafe` (`lib/canton.ts`).

## amulet-transfer.ts

app-provider mints 1000 Amulet and transfers 500 to app-user.

| Step | Who | Call |
|---|---|---|
| mint | app-provider | `POST /api/scan/v0/open-and-issuing-mining-rounds` for the amulet price, then `POST /api/validator/v0/wallet/tap` (`AmuletRules_DevNet_Tap`, the DevNet faucet) |
| offer | app-provider | `POST /api/validator/v0/wallet/token-standard/transfers`, creates an `AmuletTransferInstruction` |
| accept | app-user | `POST /api/validator/v0/wallet/token-standard/transfers/<cid>/accept` |

Everything goes through the wallet API of the validators (`:3903`, `:2903`); the wallet builds the
Token Standard commands and gets the choice contexts from Scan. The `amount` of `/tap` is in USD, not
Amulet: the wallet divides it by the `amuletPrice` of the latest open mining round (0.005 on
LocalNet, so `"amount": "1000"` would mint 200 000 Amulet). The example reads the price from Scan and
taps `1000 × price` USD to get exactly 1000 Amulet.

## utilities-token-transfer.ts

app-provider registers a new token in the Utilities registry, mints 1000 and transfers 500 to app-user.

| Step | Who | Call |
|---|---|---|
| register | operator (sv), app-provider | `lib/registrar.ts`: operator creates OperatorConfiguration; app-provider requests a ProviderService, the operator accepts it on sv; app-provider creates ProviderConfiguration, RegistrarService (+ TransferRule, AllocationFactory) and the InstrumentConfiguration. Idempotent |
| mint offer | registrar | `POST /api/utilities/v0/registry/mint/v0/offer` → `AllocationFactory_OfferMint` |
| mint accept | holder | `POST /api/utilities/v0/registry/mint/v0/offer/<cid>/choice-contexts/accept` → `MintOffer_Accept` |
| offer | app-provider | `POST .../registry/transfer-instruction/v1/transfer-factory` → `TransferFactory_Transfer` |
| accept | app-user | `POST .../registry/transfer-instruction/v1/<cid>/choice-contexts/accept` → `TransferInstruction_Accept` |

Commands go to the participant JSON Ledger API of the acting party (`:4975` operator, `:3975`
app-provider, `:2975` app-user). Factories, choice contexts and disclosed contracts come from the
operator's hosted-backend, reachable on every `utility.localhost` port; the example uses `:3000`
(`.../registry` = `/api/token-standard/v0/registrars/<registrar>/registry`). In this example the
registrar mints to itself, so it is also the holder that accepts the mint offer.

Balances are read from the Token Standard `Holding` interface views, and the total supply from
`.../registry/metadata/v1/instruments/<id>`.

All commands pin the Utilities package versions hosted-backend is built against
(`BACKEND_PACKAGES` in `lib/registrar.ts`, see the main README, "Package version pinning"). Update them when upgrading
hosted-backend.

## Files

- `lib/canton.ts`: localnet endpoints, JWT, JSON Ledger API client.
- `lib/registrar.ts`: registrar onboarding and instrument registration in the Utilities registry.
