# canton-utilities-localnet

A local Canton Network for building on **Splice** and **Digital Asset Utilities**: the upstream
Splice 0.10.3 LocalNet plus the full Utilities stack (UI, hosted-backend, darsyncer, PQS). The
Utilities API and the Token Standard off-ledger registry API
(`/api/token-standard/v0/registrars/<registrar>/registry/...`) run on localhost, so registrars,
tokens (instruments), mints and transfers can be developed and tested without DevNet.

## Why this project exists

Canton applications that issue, hold or move tokens of the **Digital Asset Registry** (any token
issued through it, such as stablecoins and RWAs) work with the **Digital Asset Utilities**
registry: a registrar creates an instrument, mints holdings and lets them move through the
Token Standard transfer and allocation workflows (CIP-56 and its backwards-compatible V2 extension
CIP-112; this localnet serves both the `v1` and the `v2` registry APIs). Wallets and apps talk to the registry
through an off-ledger API that hands out factory contracts, choice contexts and disclosed contracts.

On LocalNet none of this exists:

- **Utilities isn't part of LocalNet** and has no published source code. Digital Asset hosts the
  backend for MainNet, DevNet and TestNet (`api.utilities.digitalasset*.com`); DARs are delivered
  "as part of technical onboarding". The images are public, though: the darsyncer image contains the
  DARs with their Daml sources, and the OpenAPI specs are inside the hosted-backend jar.
- **hosted-backend isn't documented anywhere.** hosted-backend is the off-ledger service of the
  Utilities registry: the server behind `api.utilities.digitalasset.com`, run by the operator
  (Digital Asset) for the whole network. Wallets, apps and the Utilities UI ask it for the factory
  contracts, choice contexts and disclosed contracts they need to mint, burn, transfer and allocate
  registry tokens through the Token Standard, and for instrument metadata. Only its docker image is
  public; no documentation describes how to run it. How to run it locally (PQS, auth, operator
  party, JSON API, package versions) had to be reverse engineered from the images, configs, backend
  bytecode and Canton logs. What it provides is described in [hosted-backend](#hosted-backend).
- **The official answer is "use DevNet".** In a forum thread about an AMM with LP tokens on LocalNet
  the reply was: "You won't be able to replicate the full registry workflow on localnet"
  ([thread](https://forum.canton.network/t/how-to-get-the-utility-registry-dars-for-an-amm-lp-token-build-on-localnet/8798)).
  The Splice docs recommend Amulet with the Scan registry as a substitute for third-party registries
  ([cf-docs PR](https://github.com/canton-network/cf-docs/pull/2115),
  [forum](https://forum.canton.network/t/testing-cip-56-on-localnet/9082)).
- **cn-quickstart lags behind Splice.** Its localnet template targets old versions and doesn't start
  on current images (changed config schemas, healthcheck tools missing from the images).

DevNet-only development means a slow feedback loop, shared state, onboarding before the first line
of code, and no way to run integration tests in CI. This project gives the full registry workflow
locally: one `make up`, and a registrar can create its own tokens, mint them and transfer them
between parties on different participants, through the same APIs as on DevNet.

### Existing projects and documentation (checked November 2026)

None of these run Utilities locally:

- **DA Registry docs** ([quickstart](https://docs.digitalasset.com/registry/get-started/quickstart.md),
  [FAQ](https://docs.digitalasset.com/registry/support/faq)): the Registry UI is hosted by DA, users
  deploy only a validator (and optionally the Wallet Gateway). LocalNet isn't mentioned.
- **USDCx / xReserve setup** ([docs](https://docs.digitalasset.com/usdcx-xreserve/technical-setup)):
  the only official docker compose instructions. They add a frontend and a darsyncer to a validator,
  but the backend is always remote (`UTILITY_BACKEND_URL=https://api.utilities.digitalasset.com`).
- [peacefulstudio/canton-localnet](https://github.com/peacefulstudio/canton-localnet): a maintained
  reusable LocalNet for integration tests (Splice 0.10.2, PQS, Keycloak, observability). Its
  token-standard registry is the Amulet registry served by Scan. Its approach of vendoring the
  localnet from `hyperledger-labs/splice` instead of cn-quickstart was adopted here.
- [bitdynamics-ab/canton-devkit](https://github.com/bitdynamics-ab/canton-devkit): a CLI and web UI
  (also a DPM component) that manages Splice LocalNet instances pinned by commit SHA (up to Splice
  0.10.2), with DAR hot deploy, ledger inspection, snapshots and token commands. Its tokens are
  Amulet and the Splice test token (`splice-test-token-v2`), not Utilities registry instruments.
- [Fairmint/canton-dev-tools](https://github.com/Fairmint/canton-dev-tools): a CLI wrapper around
  cn-quickstart (default pin Splice 0.6.14).
- [NaundorfIT/cc-dev-llm-context](https://github.com/NaundorfIT/cc-dev-llm-context): a CIP-56 example
  on LocalNet using Amulet.
- [digital-asset/cn-quickstart](https://github.com/digital-asset/cn-quickstart): the base most of
  these build on.

## Getting started

### Requirements

- Docker with Compose v2, GNU make, bash and curl; 16 GB of RAM is recommended.
- For the maintenance targets only: git and access to GitHub (`make vendor-splice`, `make openapi`)
  and unzip (`make openapi`).
- `*.localhost` resolving to `127.0.0.1` (default on Linux with systemd-resolved and on macOS; otherwise
  add `utility.localhost`, `wallet.localhost`, `scan.localhost`, `canton.localhost` to `/etc/hosts`).
- Node.js 22.18+ for the examples (it runs TypeScript directly, no build step).

### Start and stop

```bash
make up          # pull images, start all containers, resolve party IDs (first start takes a few minutes)
make down        # stop and remove the containers; ledger data stays in the postgres volume
```

`make up` is idempotent. On first start it also allocates the Utilities operator party (see
[Parties](#parties)). After it returns, darsyncer and hosted-backend may need another 30–60 s to
upload the DARs and connect to PQS. To start from an empty ledger, remove the volumes:
`docker compose -p localnet down -v` (all party IDs change after that, see [Parties](#parties)).

Other targets:

```bash
make party-ids                            # re-resolve party IDs, recreate hosted-backend if they changed
make vendor-splice SPLICE_VERSION=<tag>   # upgrade Splice, see "Upgrading"
make openapi                              # re-collect the OpenAPI specs shown in Swagger UI
```

### Run the examples

```bash
cd examples
node amulet-transfer.ts                 # app-provider mints 1000 Amulet, transfers 500 to app-user
node utilities-token-transfer.ts DEMO   # register token DEMO, mint 1000, transfer 500 to app-user
```

- `amulet-transfer.ts` uses the Splice wallet API: tap (the DevNet faucet), then a Token Standard
  two-step transfer that app-user accepts.
- `utilities-token-transfer.ts` onboards app-provider as provider and registrar under the
  `utility-operator` party (the operator accepts on the sv participant), registers the instrument
  (idempotent, any id can be passed), mints through `MintOffer`, transfers through the Token Standard
  `TransferFactory`, and app-user accepts the `TransferInstruction` on its own participant.

Both print every step, the contract ids and the balances before and after. Details, the API calls of
every step and type checking: [`examples/README.md`](examples/README.md).

After the second example the registry API of the new registrar answers:

```bash
PARTY=$(grep APP_PROVIDER_PARTY_ID modules/localnet/.party-ids.env | cut -d= -f2)
curl "http://utility.localhost:3000/api/token-standard/v0/registrars/$PARTY/registry/metadata/v1/instruments"
```

The web UIs show the same state. Each port belongs to one participant, and a user exists only on
its own participant, so log in with the user name that matches the port:

| UI | Log in as |
|---|---|
| <http://utility.localhost:3000>, <http://wallet.localhost:3000> | `app-provider` |
| <http://utility.localhost:2000>, <http://wallet.localhost:2000> | `app-user` |
| <http://wallet.localhost:4000>, <http://sv.localhost:4000> | `sv` |

With a wrong name (e.g. `app-provider` on port 2000) the participant answers
`GET /v2/users/<name>` with 403 (`UserNotFound`), and the Utilities UI keeps retrying with a spinner
instead of showing an error.

The Utilities UI login form disables the **Login** button for user names containing a hyphen
(`app-user`, `app-provider`), but pressing **Enter** in the field still logs in.

---

## Technical details

### Containers

Upstream Splice LocalNet:

| Container | What it is |
|---|---|
| `postgres` | One Postgres 18 for everything; a database per component (`env/postgres.env`) |
| `canton` | Canton node: participants `sv`, `app-provider`, `app-user`, the global synchronizer's sequencer and mediator, plus `app-sequencer` / `app-mediator` for the optional upstream multi-sync profile |
| `splice` | Splice apps: SV app, Scan, and a validator per participant (wallet, ANS) |
| `nginx` | Reverse proxy for all UIs and APIs on ports 2000 / 3000 / 4000 by host name |
| `wallet-web-ui-<role>`, `ans-web-ui-app-*`, `sv-web-ui`, `scan-web-ui` | Splice web UIs |
| `swagger-ui` | Swagger UI on `:9090`, see [Swagger UI](#swagger-ui) |

Utilities, images from `europe-docker.pkg.dev/da-images/public/docker`. The layout follows
DevNet/MainNet: every validator runs the UI and has the DARs, while one backend run by the operator
serves the whole network (on DevNet that is `api.utilities.digitalasset.com`).

| Container | Image | What it is |
|---|---|---|
| `darsyncer-<role>` (all three) | `utilities-darsyncer-client` | Uploads the Utilities DARs (registry, holding, credential, commercials, all versions) to its participant, then keeps running |
| `utility-ui-<role>` (all three) | `frontend` | Utilities web UI; talks to its own participant's JSON Ledger API and to the operator's backend |
| `pqs-sv` | `participant-query-store` | Participant Query Store of the sv participant, database `pqs-sv`. The operator observes every registry contract, so this store has the whole registry |
| `hosted-backend-sv` | `hosted-backend` | Utilities backend acting for `utility-operator`: Utilities API and Token Standard registry API for every registrar |

Versions:

| Component | Version | Where |
|---|---|---|
| Splice (`canton`, `splice-app`, `*-web-ui`) | 0.10.3 | `Makefile` → `IMAGE_TAG`, `vendor/splice.ref` |
| Utilities `frontend`, `utilities-darsyncer-client` | 0.15.4 | `compose.env` → `UTILITIES_IMAGE_VERSION` |
| Utilities `hosted-backend` | 0.14.15 | `compose.env` → `UTILITIES_BACKEND_VERSION` |
| Participant Query Store | 3.7.3 | `compose.env` → `PQS_VERSION` |
| Postgres, nginx | as upstream (digest-pinned) | `compose.env` |

### Parties

LocalNet has three participants in one `canton` container, each with a validator in the `splice`
container. Every validator onboards one party. On top of that, `make up` allocates the Utilities
registry operator on the sv participant. A party id ends with its participant's key fingerprint,
which is generated on first start, so ids differ between installations and change after `down -v`.

| Party | Participant | Role | Users (Ledger API / wallet) |
|---|---|---|---|
| `app_provider_localnet-localparty-1::1220…` | app-provider | Validator party of the app provider. In the examples: Amulet sender; Utilities provider and registrar (issuer of the tokens) | `ledger-api-user`, `app-provider` |
| `app_user_localnet-localparty-1::1220…` | app-user | Validator party of the app user. In the examples: receiver of Amulet and tokens | `ledger-api-user`, `app-user` |
| `utility-operator::1220…` | sv | Utilities registry operator, the role Digital Asset has on DevNet/MainNet. Accepts providers, observes all registry contracts; hosted-backend runs on its behalf | `ledger-api-user` |
| `sv::1220…` | sv | Super validator: runs the synchronizer, Scan and the SV app | `ledger-api-user`, `sv` |
| `DSO::1220…` | sv | Decentralized synchronizer operator: admin of Amulet (`instrumentId.admin`) and `AmuletRules` | — |

The Utilities roles are separate parties on separate participants, as on DevNet: the operator is
not the provider, so onboarding goes through a real request/accept between two participants, and
authorization mistakes in an application show up locally.

`make up` (`tools/party-ids.sh`) writes the current ids to `modules/localnet/.party-ids.env`. It
allocates `utility-operator` on first run and grants `ledger-api-user` on sv `CanActAs` for it:

```bash
cat modules/localnet/.party-ids.env
# APP_USER_PARTY_ID=app_user_localnet-localparty-1::1220...
# APP_PROVIDER_PARTY_ID=app_provider_localnet-localparty-1::1220...
# SV_PARTY_ID=sv::1220...
# UTILITY_OPERATOR_PARTY_ID=utility-operator::1220...
```

The examples find the parties themselves: a validator party is the primary party of
`ledger-api-user` (`GET /v2/users/ledger-api-user`), the operator is the `utility-operator::…`
`CanActAs` right of `ledger-api-user` on sv, and a wallet party comes from
`GET /api/validator/v0/wallet/user-status`. More parties can be allocated through the Ledger API or
onboarded through the wallet.

### Authentication

Calls to the JSON Ledger API and the validator/wallet API need a JWT, e.g. for "Authorize" in
[Swagger UI](#swagger-ui) or for curl. The examples create their own tokens, the UIs need only the
user name, and the Utilities and Token Standard registry endpoints are public.

All tokens are unsafe HS256 JWTs signed with the secret `unsafe`, audience
`https://canton.network.global`, `sub` = user name, no expiry, so these are valid on any
installation. A user exists only on its own participant.

| User | Participant (ports) | Token |
|---|---|---|
| `ledger-api-user` | every participant: validator party, plus `utility-operator` on sv; validator admin API | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsZWRnZXItYXBpLXVzZXIiLCJhdWQiOiJodHRwczovL2NhbnRvbi5uZXR3b3JrLmdsb2JhbCJ9.G9aLv-IF5X0WmIkbR10f48i-7it5LlgwpJEZ4Ce2Y-E` |
| `app-provider` | app-provider (`3975`, `3903`, `wallet.localhost:3000`) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhcHAtcHJvdmlkZXIiLCJhdWQiOiJodHRwczovL2NhbnRvbi5uZXR3b3JrLmdsb2JhbCJ9.Jg0ZwvXUoqT_qCejNcDayz9uOhtKH-o1BHet9X6Wyuc` |
| `app-user` | app-user (`2975`, `2903`, `wallet.localhost:2000`) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhcHAtdXNlciIsImF1ZCI6Imh0dHBzOi8vY2FudG9uLm5ldHdvcmsuZ2xvYmFsIn0.wsKLeGR95BRp50Es7689DmW8EAGGkVcEKPykGDuvnMM` |
| `sv` | sv (`4975`, `4903`, `wallet.localhost:4000`) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzdiIsImF1ZCI6Imh0dHBzOi8vY2FudG9uLm5ldHdvcmsuZ2xvYmFsIn0.vGRV1xCfrlV2dBZNxJi2EK6_OO6u985dJWqD6MeRWlg` |

`token()` in `examples/lib/canton.ts` creates a token for any other user.

### Ports and APIs

All ports are bound to `127.0.0.1` (override with `HOST_BIND_IP`). Ports 2xxx belong to app-user,
3xxx to app-provider, 4xxx to sv.

Direct ports:

| API | app-user | app-provider | sv |
|---|---|---|---|
| Ledger API gRPC | 2901 | 3901 | 4901 |
| Participant Admin API gRPC | 2902 | 3902 | 4902 |
| JSON Ledger API v2 (`/v2/...`, OpenAPI at `/docs/openapi`) | 2975 | 3975 | 4975 |
| Validator API (`/api/validator/...`, wallet at `/api/validator/v0/wallet/...`) | 2903 | 3903 | 4903 |

Plus Postgres on `5432` (user `cnadmin`, password `supersafe`) and Swagger UI on `9090`.

Through nginx, by host name, on ports 2000 (app-user), 3000 (app-provider), 4000 (sv):

| Host | Paths | Backend |
|---|---|---|
| `utility.localhost` | `/api/utilities/...` | operator's hosted-backend (on every port): Utilities API (instrument configurations, mint/burn factories and choice contexts) |
| | `/api/token-standard/v0/registrars/<party>/registry/...` | operator's hosted-backend (on every port): Token Standard registry API (`metadata/v1`, `transfer-instruction/v1`, `allocation-instruction/v1`, `allocation/v1`, and v2) |
| | `/api/validator/...`, `/api/json-api/...` | this port's validator API and JSON Ledger API, including WebSocket streams (used by the UI) |
| | `/` | Utilities UI |
| `utilities.localhost` | any | 301 redirect to `utility.localhost` |
| `wallet.localhost` | `/`, `/api/validator/...` | Wallet UI and validator API |
| `ans.localhost` (2000, 3000) | `/` | ANS UI |
| `canton.localhost`, `json-ledger-api.localhost` (2000, 3000) | `/` | JSON Ledger API |
| `grpc-ledger-api.localhost` (2000, 3000) | gRPC | Ledger API |
| `scan.localhost` (4000) | `/api/scan/...`, `/registry/...`, `/` | Scan API, Amulet Token Standard registry API, Scan UI |
| `sv.localhost` (4000) | `/api/sv/...`, `/` | SV API and UI |

A host name nginx doesn't know (e.g. `localhost:3000`) gets the first server of the port's config,
which is the ANS UI on 2000 and 3000 (upstream behaviour).

The registry API answers the same on all three ports, because they all lead to the one
operator's backend.

### Swagger UI

<http://localhost:9090> lists these APIs (top right, "Select a definition"):

| Definition | Spec source | Servers ("Try it out") | Auth ("Authorize") |
|---|---|---|---|
| JSON Ledger API: app-provider / app-user / sv | the participant itself, `canton.localhost:<port>/docs/openapi` (upstream) | that participant | Bearer JWT, e.g. `ledger-api-user` |
| Splice Validator API | `validator-internal.yaml` from hyperledger-labs/splice | `wallet.localhost:3000/2000/4000/api/validator` | Bearer JWT; `/v0/admin/...` needs `ledger-api-user`, the rest the wallet user |
| Splice Wallet API | `wallet-internal.yaml` from hyperledger-labs/splice | same as above | Bearer JWT of the wallet user (`app-provider`, `app-user`, `sv`) |
| Utilities API | `utility.yaml` from the hosted-backend jar | `utility.localhost:3000/2000/4000` (all reach the operator's backend) | not needed |
| Token Standard registry v1: metadata, transfer instruction, allocation instruction, allocation | `utility-token-standard/v1/*.yaml` from the hosted-backend jar | same as above | not needed |
| Token Standard registry v2: transfer instruction, allocation instruction, allocation | `utility-token-standard/v2/*.yaml` from the hosted-backend jar | same as above | not needed |

Tokens for "Authorize" are HS256 JWTs as described in [Authentication](#authentication); paste
only the token, without `Bearer`. Choose the server that matches the token's user: the
`app-user` token works only against `wallet.localhost:2000`.

The Splice images don't contain their OpenAPI specs, and the Utilities specs are only inside
`/app/backend.jar`, so `tools/openapi.sh` (`make openapi`) collects them into `openapi/`: the Splice
specs from hyperledger-labs/splice at the tag in `vendor/splice.ref` (keeping the repository's
directory tree, since the specs reference each other by relative paths), and the Utilities specs
from the hosted-backend image of `UTILITIES_BACKEND_VERSION`. It replaces each spec's `servers`
(upstream has `https://example.com/api/validator` and `http://localhost:8080`) with the localnet
hosts and adds a bearer security scheme to the wallet spec, which declares none. The swagger-ui
container serves `openapi/` itself, so the specs load from the same origin; "Try it out" calls the
APIs cross-origin, which works because the validator and hosted-backend answer CORS requests.

### hosted-backend

`hosted-backend` (image `europe-docker.pkg.dev/da-images/public/docker/hosted-backend`, a JVM app in
`/app/backend.jar`) is the off-ledger part of the Utilities registry. The registry itself is on the
ledger (the `utility-registry-*` Daml packages: instrument configurations, holdings, transfer rules,
factories); hosted-backend makes it usable from outside:

- it reads the registry contracts the operator can see, from a **PQS** datastore of the operator's
  participant (plus `contract-by-id` lookups on the operator's JSON Ledger API);
- it answers the **Token Standard off-ledger API** (CIP-56 v1 and CIP-112 v2) for every registrar, so
  that any CIP-56/112 wallet can work with registry tokens the same way as with Amulet (which Scan
  serves);
- it answers the **Utilities API** for registry-specific workflows that are not in the Token
  Standard: two-step mint and burn, burn-mint, instrument configurations.

Its API has no endpoint that submits a transaction. A call returns data for a command that the
caller submits on its own participant: a factory contract id, a **choice context**
(`choiceContextData`, extra arguments of the choice, e.g. the `InstrumentConfiguration` contract id
or the issuer's credentials) and **disclosed contracts** (contracts the caller's participant doesn't see but the transaction needs,
passed as created-event blobs). The endpoints need no authentication.

On DevNet/MainNet there is one hosted-backend, run by Digital Asset as the operator. Here it is
`hosted-backend-sv`, acting for `utility-operator`, and every `utility.localhost` port routes to it.

**Token Standard registry API**, `/api/token-standard/v0/registrars/<registrar>/registry/...`
(`<registrar>` = the `instrumentId.admin` party; the same paths that CIP-56 defines for any registry,
behind this prefix):

| Endpoint | Purpose |
|---|---|
| `GET metadata/v1/info`, `GET metadata/v1/instruments`, `GET metadata/v1/instruments/<id>` | Registry info (admin party, supported Token Standard APIs v1/v2), instruments with name, symbol, decimals and total supply |
| `POST transfer-instruction/v1/transfer-factory` (`/v2/...`) | Factory and context for `TransferFactory_Transfer`: start a transfer |
| `POST transfer-instruction/v1/<cid>/choice-contexts/accept`, `.../reject`, `.../withdraw` (`/v2/...`) | Context for the receiver to accept or reject, or the sender to withdraw, a `TransferInstruction` |
| `POST allocation-instruction/v1/allocation-factory` (`/v2/...`) | Factory and context for `AllocationFactory_Allocate`: lock holdings for a DvP settlement leg |
| `POST allocations/v1/<cid>/choice-contexts/execute-transfer`, `.../withdraw`, `.../cancel` (`v2`: `withdraw`, `cancel`) | Context to settle, withdraw or cancel an allocation |
| `POST allocation/v2/settlement-factory` | v2 only: factory and context for `SettlementFactory_SettleBatch`, settling several allocations at once |

**Utilities API**, `/api/utilities/v0/...`:

| Endpoint | Purpose |
|---|---|
| `GET operator` | The operator party (the UI shows only holdings with this `operator`) |
| `GET package/all` | Utilities packages in use |
| `GET contract/instrument-configuration/all`, `POST contract/instrument-configuration` | Instrument configurations (all, or one by registrar and id) |
| `POST registry/mint/v0/offer`, `POST registry/mint/v0/request` | Factory and context to create a `MintOffer` (registrar offers) or `MintRequest` (holder asks) |
| `POST registry/mint/v0/{offer,request}/<cid>/choice-contexts/{accept,reject,cancel}` | Context to accept, reject or cancel a mint offer or request |
| `POST registry/burn/v0/offer`, `POST registry/burn/v0/request`, `.../<cid>/choice-contexts/{accept,reject,cancel}` | The same for burns |
| `POST registry/burn-mint-instruction/v0/burn-mint-factory` | Factory and context for `BurnMintFactory_BurnMint` (burn inputs and mint outputs in one transaction) |
| `POST registry/transfer/v0/proof` | Verify the outcome of a transfer of registry tokens |
| `GET openapi` | The OpenAPI spec of this API |

Plus `/readyz` and `/livez`. The full specs are in Swagger UI (see [Swagger UI](#swagger-ui)) and in
`openapi/utilities/`. `examples/utilities-token-transfer.ts` uses the mint offer, transfer factory,
transfer accept and metadata endpoints.

**Version.** The public registry `europe-docker.pkg.dev/da-images/public/docker` has `frontend` and
`utilities-darsyncer-client` up to 0.15.4, but `hosted-backend` only up to 0.14.15: there is no
0.15.x backend (checked November 2026). So this localnet runs the newest public images of each,
UI and darsyncer 0.15.4 with backend 0.14.15. darsyncer 0.15.4 uploads Utilities packages newer than
the ones the backend is built for (e.g. `utility-registry-app-v0` 0.10.0 against 0.9.3), and the
backend fails to decode contracts with fields it doesn't know. Hence the package pinning ("Package
version pinning" in [Utilities on LocalNet](#utilities-on-localnet-what-had-to-be-configured)). When a newer
hosted-backend is published: bump `UTILITIES_BACKEND_VERSION` in `compose.env`, update
`BACKEND_PACKAGES` in `examples/lib/registrar.ts` from the codegen classes of the new
`/app/backend.jar`, and run `make openapi`.

### Layout

```
vendor/splice-localnet/   pristine upstream LocalNet (hyperledger-labs/splice, cluster/compose/localnet)
vendor/splice.ref         its tag and commit
modules/localnet/         working copy: upstream + Utilities additions, used by the Makefile
examples/                 TypeScript examples (Amulet, Utilities token)
tools/party-ids.sh        writes modules/localnet/.party-ids.env (run by make up)
tools/vendor-splice.sh    3-way merge of a new Splice release (make vendor-splice)
tools/openapi.sh          collects the OpenAPI specs for Swagger UI into openapi/ (make openapi)
openapi/                  Validator, Wallet, Utilities and Token Standard registry specs (generated)
```

### Changes to upstream Splice LocalNet

`modules/localnet/` is `vendor/splice-localnet/` (Splice 0.10.3) with additions only; everything else
is byte-for-byte upstream. `diff -r vendor/splice-localnet modules/localnet` shows:

| File | Addition |
|---|---|
| `compose.yaml` | Services `utility-ui-<role>` and `darsyncer-<role>` for each role, `pqs-sv` and `hosted-backend-sv` for the operator; nginx `depends_on` the utility-ui and hosted-backend services (`required: false`) |
| `compose.env` | `UTILITIES_IMAGE_REPO`, `UTILITIES_IMAGE_VERSION`, `UTILITIES_BACKEND_VERSION`, `PQS_IMAGE_REPO`, `PQS_VERSION`, `PQS_LEDGER_API_TOKEN` |
| `env/postgres.env` | Database `pqs-sv` |
| `conf/nginx/{app-provider,app-user,sv}.conf` | A `server utility.localhost` block (Utilities UI, operator's hosted-backend, JSON Ledger API with WebSocket) and a redirect from `utilities.localhost` |
| `resource-constraints.yaml` | 256 MB `mem_limit` for utility-ui and darsyncer |
| `swagger-ui.yaml` (new file) | Compose override for the upstream `swagger-ui` service: the list of specs and the `openapi/` mount (see [Swagger UI](#swagger-ui)) |

Outside `modules/localnet`, the `Makefile` passes `.party-ids.env` and `swagger-ui.yaml` to compose, enables the profiles
`sv`, `app-provider`, `app-user` and `swagger-ui`, and runs `tools/party-ids.sh` after `make up`
(which allocates the operator party and recreates hosted-backend when the ids change).

### Utilities on LocalNet: what had to be configured

**nginx.** The `utility.localhost` server routes `/api/utilities/` and `/api/token-standard/` to
hosted-backend through `resolver 127.0.0.11` and a variable upstream. Otherwise nginx caches the
backend's IP at startup and sends requests to a wrong container after the backend is recreated.
`/api/json-api/` forwards the WebSocket upgrade headers: the UI reads the active contract set over a
WebSocket (`/v2/state/active-contracts`) and otherwise falls back to slower HTTP polling.

**PQS.** hosted-backend 0.13+ needs a PQS datastore at startup
(`HikariPool$PoolInitializationException ... localhost:5432 refused` without one).

- `PQS_PIPELINE_LEDGER_START=Oldest`: `Genesis` refuses to restart on a non-empty datastore.
- `PQS_PIPELINE_FILTER_METADATA=*`: hosted-backend reads created-event blobs (the `metadata` column);
  without it requests fail with `NonNullableColumnRead ... column 9`. Changing PQS filters requires
  dropping and recreating the `pqs-*` databases (PQS re-ingests from `Oldest`).
- The healthcheck uses bash `/dev/tcp` + `read` against `/readyz`: the image has no curl, wget or head.

**hosted-backend.**

- Ledger API auth: PQS and hosted-backend act as `ledger-api-user` with a static token
  (`PQS_LEDGER_API_TOKEN`). The hosted-backend defaults (`user=unsafe`,
  `aud=https://utility.canton.network`) are rejected with `UNAUTHENTICATED`, hence
  `UTILITY_OPERATOR_USER`, `USER_VALIDATOR_LEDGER_API_USER` and `SERVICE_ACCOUNT_AUDIENCE`.
- `JSON_API_URL=canton:<N>975`: the default `localhost:7575` makes startup hang silently while it
  resolves the synchronizer id (port 8080 never opens, nothing in the logs).
- `OPERATOR_PARTY_ID` must be a real party (the default `operator` gives `PERMISSION_DENIED`), and the
  backend must run on the operator's participant: it reads contracts as the operator (for example
  `contract-by-id` for mint choice contexts), which fails with 403 on a participant that doesn't host
  that party. Party ids are generated on first start, so `make up` runs `tools/party-ids.sh`, which
  allocates `utility-operator`, writes `modules/localnet/.party-ids.env` (gitignored) and recreates
  hosted-backend if the ids changed.
- One operator for the whole network matters for the UI as well: it shows only holdings whose
  `operator` equals the operator reported by `/api/utilities/v0/operator`. Per-validator backends with
  different operators leave the holdings page empty on every validator but the operator's own.

**Registrar onboarding** (`onboardRegistrar()` in `examples/lib/registrar.ts`):

| Step | Submitted by | Participant |
|---|---|---|
| `OperatorConfiguration` | operator | sv |
| `ProviderServiceRequest` | provider (app-provider) | app-provider |
| `ProviderServiceRequest_Accept` → `ProviderService` | operator | sv |
| `ProviderService_CreateProviderConfiguration` → `ProviderConfiguration` | provider | app-provider |
| `RegistrarServiceRequest`, `ProviderService_AcceptRegistrarServiceRequest` → `RegistrarService`, `TransferRule`, `AllocationFactory` | registrar, provider (both app-provider) | app-provider |
| `RegistrarService_CreateInstrumentConfiguration` → `InstrumentConfiguration` per token | registrar | app-provider |

Each step is skipped if already done. The operator is a signatory only of `OperatorConfiguration`,
`ProviderService` and `ProviderConfiguration`; on holdings, transfer rules, instrument configurations
and transfer offers it is an observer, so the sv participant sees the registry without confirming its
transactions.

**Package version pinning.** darsyncer 0.15.4 uploads several versions of every Utilities package
(e.g. registry-app 0.7.0 … 0.10.0), and by default the participant picks the newest. hosted-backend
0.14.15 is compiled against registry-app 0.9.3, registry 0.8.3, holding 0.3.3, credential 0.1.2,
credential-app 0.4.3 and commercials 0.4.2, and its decoder fails on newer fields
(`Unknown field blockListInitiated`). The examples pin these package ids through
`packageIdSelectionPreference` on every command. Update `BACKEND_PACKAGES` in `examples/lib/registrar.ts`
when upgrading hosted-backend (the ids are in the codegen classes of `/app/backend.jar`).

### Upgrading

- **Splice:** `make vendor-splice SPLICE_VERSION=<tag>`. For every upstream file it runs a 3-way merge
  (`git merge-file`: base = old snapshot, ours = `modules/localnet`, theirs = new upstream), copies
  new upstream files, reports files removed upstream, then advances `vendor/splice-localnet/`,
  `vendor/splice.ref` and `IMAGE_TAG` in the `Makefile`. Conflicts are left as `<<<<<<< local` /
  `>>>>>>> splice <tag>` markers and the script exits non-zero. Since the local changes are only
  additions at the end of files, upgrades should merge cleanly.
- **Utilities, PQS, hosted-backend:** not part of upstream; bump them in `modules/localnet/compose.env`.
  After a hosted-backend upgrade, update `BACKEND_PACKAGES` (see above) and re-check the
  hosted-backend environment variables.
- **OpenAPI specs:** after either upgrade, run `make openapi` to refresh `openapi/`.

### Debugging

- hosted-backend logs almost nothing (even with `LOG_LEVEL_ROOT=DEBUG`), and its image has no shell.
  A JVM thread dump (`docker kill -s QUIT <container>`, then `docker logs`) shows where it is stuck.
- hosted-backend turns registrar lookup errors into `404 Registrar ... not found`. Call it directly to
  see the real error:
  `docker run --rm --network container:hosted-backend-sv curlimages/curl:8.11.1 -s http://127.0.0.1:8080/...`
- Canton logs every Ledger API request with its auth claims (`docker logs canton | grep <container IP>`),
  which shows `UNAUTHENTICATED` / `PERMISSION_DENIED` from Utilities services.
- The OpenAPI specs of hosted-backend are inside `/app/backend.jar` (`utility.yaml`,
  `utility-token-standard/v{1,2}/*.yaml`). The Daml sources are inside the DARs in the darsyncer
  image (`/dars`).

## License

[MIT](LICENSE), except for third-party content:

- `vendor/splice-localnet/` and the upstream files in `modules/localnet/` come from
  [hyperledger-labs/splice](https://github.com/hyperledger-labs/splice) and remain under their
  original license (Apache-2.0, see the SPDX headers in the files).
- `openapi/` contains third-party OpenAPI specs, with `servers` (and the wallet's security scheme)
  adapted to the localnet: `openapi/splice/` comes from hyperledger-labs/splice (Apache-2.0);
  `openapi/utilities/` is extracted from Digital Asset's public hosted-backend image. The Token
  Standard specs there carry an Apache-2.0 header; `utility.yaml` states no license and remains
  Digital Asset's.
- The Utilities, PQS and Splice docker images are not part of this repository; they are pulled at
  runtime and are subject to their publishers' terms.
