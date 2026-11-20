// Utilities token transfer: app-provider registers a new token in the Utilities registry, mints
// 1000 of it and transfers 500 to app-user.
//
//   1. register  app-provider is onboarded as provider and registrar under the utility-operator
//                party on sv, and creates an InstrumentConfiguration for the token (lib/registrar.ts)
//   2. mint      registrar offers a mint to the holder (AllocationFactory_OfferMint),
//                the holder accepts it (MintOffer_Accept); here holder = registrar
//   3. offer     provider transfers 500 to app-user through the Token Standard TransferFactory;
//                the tokens are locked in a TransferInstruction until the receiver decides
//   4. accept    app-user accepts the TransferInstruction and receives the tokens
//
// Commands go to the participant JSON Ledger API. Factories, choice contexts and disclosed contracts
// come from the operator's hosted-backend:
//   Utilities API              /api/utilities/v0/registry/mint/...
//   Token Standard registry    /api/token-standard/v0/registrars/<registrar>/registry/...
//
// Run: node utilities-token-transfer.ts [INSTRUMENT_ID]   (default DEMO)
import {
  APP_PROVIDER, APP_USER, SV, UTILITY_OPERATOR_HINT, type Disclosed, type Json, Ledger, eventually, http, short, shortParty,
} from "./lib/canton.ts";
import { T, onboardRegistrar, pinnedLedger } from "./lib/registrar.ts";

const INSTRUMENT_ID = process.argv[2] ?? "DEMO";
const MINT_AMOUNT = "1000";
const TRANSFER_AMOUNT = "500";

const HOLDING = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";
const TRANSFER_FACTORY = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const TRANSFER_INSTRUCTION = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

const providerLedger = pinnedLedger(APP_PROVIDER.jsonApi);
const userLedger = pinnedLedger(APP_USER.jsonApi);
const operatorLedger = pinnedLedger(SV.jsonApi);
const operator = await operatorLedger.partyByHint(UTILITY_OPERATOR_HINT);
const registrar = await providerLedger.validatorParty();
const receiver = await userLedger.validatorParty();
const instrumentId = { admin: registrar, id: INSTRUMENT_ID };

// The operator's hosted-backend serves the registry for the whole network, like
// api.utilities.digitalasset.com on DevNet. It is reachable on every utility.localhost port; the
// endpoints are public, any party may call them.
const utilitiesApi = `${APP_PROVIDER.utilities}/api/utilities/v0/registry`;
const registryApi = `${APP_PROVIDER.utilities}/api/token-standard/v0/registrars/${encodeURIComponent(registrar)}/registry`;

console.log(`operator:             ${shortParty(operator)}`);
console.log(`registrar (provider): ${shortParty(registrar)}`);
console.log(`receiver (user):      ${shortParty(receiver)}`);

const emptyMeta = { values: {} };
const now = () => new Date().toISOString();
const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

/** Unlocked holdings of this instrument owned by party, as Token Standard Holding views. */
async function holdings(ledger: Ledger, party: string) {
  return (await ledger.views(party, HOLDING)).filter(
    (h) => h.view.owner === party && h.view.instrumentId.admin === registrar && h.view.instrumentId.id === INSTRUMENT_ID && !h.view.lock,
  );
}

async function balance(ledger: Ledger, party: string): Promise<number> {
  return (await holdings(ledger, party)).reduce((sum, h) => sum + Number(h.view.amount), 0);
}

async function showBalances(label: string) {
  const p = await balance(providerLedger, registrar);
  const u = await balance(userLedger, receiver);
  console.log(`[balance]  ${label}: provider ${p} ${INSTRUMENT_ID}, user ${u} ${INSTRUMENT_ID}`);
}

/**
 * Call hosted-backend, retrying while it answers with an error: it reads the ledger through PQS,
 * which lags a little behind the participant (and catches up for a while after a restart), so a
 * contract created a moment ago can still be "not found".
 */
function backend(method: string, url: string, body?: Json): Promise<Json> {
  return eventually(`${method} ${url}`, () =>
    http(method, url, body).catch((e: Error) => {
      if (/HTTP (404|5\d\d)/.test(e.message)) return undefined; // not in PQS yet: retry
      throw e; // a real client error (bad request etc.)
    }),
  );
}

/** Instrument metadata from the Token Standard registry API of hosted-backend. */
async function showSupply() {
  const info = await backend("GET", `${registryApi}/metadata/v1/instruments/${INSTRUMENT_ID}`);
  console.log(`[registry] ${info.id} (${info.symbol}), total supply ${Number(info.totalSupply)}`);
}

// 1. Register the token: registrar onboarding + InstrumentConfiguration (idempotent).
await onboardRegistrar({ operatorLedger, operator, providerLedger, provider: registrar }, [INSTRUMENT_ID]);
await showSupply();
await showBalances("before");

// 2. Mint: the registrar offers a mint, the holder accepts it.
//    hosted-backend returns the AllocationFactory and the context (instrument configuration, credentials).
const mintFactory = await backend("POST", `${utilitiesApi}/mint/v0/offer`, { holder: registrar, instrumentId });
const offer = await providerLedger.exercise(
  registrar,
  T.allocationFactory,
  mintFactory.factoryId,
  "AllocationFactory_OfferMint",
  {
    expectedAdmin: registrar,
    mint: {
      instrumentId,
      amount: MINT_AMOUNT,
      holder: registrar,
      reference: `mint-${Date.now()}`,
      requestedAt: now(),
      executeBefore: inOneHour(),
      meta: emptyMeta,
    },
    extraArgs: { context: mintFactory.choiceContext.choiceContextData, meta: emptyMeta },
  },
  mintFactory.choiceContext.disclosedContracts,
);
const mintOfferCid: string = offer.result.mintOfferCid;
console.log(`[mint]     offer ${MINT_AMOUNT} ${INSTRUMENT_ID} to provider, MintOffer ${short(mintOfferCid)}`);

const mintAccept = await backend("POST", `${utilitiesApi}/mint/v0/offer/${mintOfferCid}/choice-contexts/accept`, {});
const minted = await providerLedger.exercise(
  registrar,
  T.mintOffer,
  mintOfferCid,
  "MintOffer_Accept",
  { extraArgs: { context: mintAccept.choiceContextData, meta: emptyMeta } },
  mintAccept.disclosedContracts,
);
console.log(`[mint]     accepted, holding ${short(minted.result.holdingCid)}`);

// 3. Transfer through the Token Standard TransferFactory.
const inputs = await holdings(providerLedger, registrar);
const transfer = {
  sender: registrar,
  receiver,
  amount: TRANSFER_AMOUNT,
  instrumentId,
  requestedAt: now(),
  executeBefore: inOneHour(),
  inputHoldingCids: inputs.map((h) => h.cid),
  meta: { values: { "splice.lfdecentralizedtrust.org/reason": "utilities-token-transfer example" } },
};
const choiceArguments = { expectedAdmin: registrar, transfer, extraArgs: { context: emptyMeta, meta: emptyMeta } };
const transferFactory = await backend("POST", `${registryApi}/transfer-instruction/v1/transfer-factory`, {
  choiceArguments,
  excludeDebugFields: true,
});
const sent = await providerLedger.exercise(
  registrar,
  TRANSFER_FACTORY,
  transferFactory.factoryId,
  "TransferFactory_Transfer",
  { ...choiceArguments, extraArgs: { context: transferFactory.choiceContext.choiceContextData, meta: emptyMeta } },
  transferFactory.choiceContext.disclosedContracts as Disclosed[],
);
const output: Json = sent.result.output;
if (output.tag !== "TransferInstructionResult_Pending") {
  throw new Error(`expected a pending transfer instruction, got ${JSON.stringify(output)}`);
}
const instructionCid: string = output.value.transferInstructionCid;
console.log(`[offer]    ${TRANSFER_AMOUNT} ${INSTRUMENT_ID} to user, TransferInstruction ${short(instructionCid)}`);

// 4. The receiver finds the pending instruction on its own participant and accepts it.
const pending = await eventually("the transfer instruction on app-user", async () =>
  (await userLedger.views(receiver, TRANSFER_INSTRUCTION)).find((ti) => ti.cid === instructionCid),
);
const t = pending.view.transfer;
console.log(`[pending]  ${Number(t.amount)} ${t.instrumentId.id} from ${shortParty(t.sender)}, status ${pending.view.status.tag}`);

const acceptCtx = await backend("POST", `${registryApi}/transfer-instruction/v1/${instructionCid}/choice-contexts/accept`, {
  meta: {},
});
const accepted = await userLedger.exercise(
  receiver,
  TRANSFER_INSTRUCTION,
  instructionCid,
  "TransferInstruction_Accept",
  { extraArgs: { context: acceptCtx.choiceContextData, meta: emptyMeta } },
  acceptCtx.disclosedContracts,
);
console.log(`[accept]   user holding ${short(accepted.result.output.value.receiverHoldingCids[0])}`);

await eventually("the provider balance update", async () =>
  (await holdings(providerLedger, registrar)).some((h) => inputs.every((i) => i.cid !== h.cid)) ? true : undefined,
);
await showBalances("after");
await showSupply();
