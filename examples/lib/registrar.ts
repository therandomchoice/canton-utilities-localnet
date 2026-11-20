// Registrar onboarding in the Utilities registry and instrument (token) registration.
//
// Roles, as on DevNet/MainNet where Digital Asset is the operator:
//   operator             utility-operator party on the sv participant (tools/party-ids.sh)
//   provider, registrar  app-provider validator party
//
// Steps (each skipped if already done, so it is idempotent):
//   1. OperatorConfiguration                      operator creates                    (sv)
//   2. ProviderServiceRequest -> ProviderService   provider requests, operator accepts (app-provider -> sv)
//   3. ProviderConfiguration                       provider, via ProviderService       (app-provider)
//   4. RegistrarServiceRequest -> RegistrarService + TransferRule + AllocationFactory
//                                                  registrar requests, provider accepts (app-provider)
//   5. InstrumentConfiguration per instrument      registrar                            (app-provider)
//
// Package versions: darsyncer uploads several versions of every Utilities package, and by default
// the participant picks the newest one. hosted-backend decodes contracts with codegen for one fixed
// set of versions and fails on unknown fields (e.g. RegistrarService.blockListInitiated, added in
// utility-registry-app-v0 0.10.0). So every command pins BACKEND_PACKAGES via
// packageIdSelectionPreference. Update the list when upgrading hosted-backend.
import { type ActiveContract, type Json, Ledger, created, eventually } from "./canton.ts";

/** Package ids hosted-backend 0.14.15 was compiled against (from its codegen classes). */
export const BACKEND_PACKAGES: Record<string, string> = {
  "utility-registry-app-v0 0.9.3": "11c6368c711b96533e0f24a6eeed9625c98aad73c92ef3435ddc6e156da0e7c2",
  "utility-registry-v0 0.8.3": "1ba1dbfd46f069c62b497c79b465fa2432b3aca5f5270f06ad2b03cab421e367",
  "utility-registry-holding-v0 0.3.3": "74534a45e238948d031aad9fd788c947883cd9d63b2010d9b920ea1ff3aad907",
  "utility-credential-v0 0.1.2": "044be226f82e81609111569fb7253421cdb86b2bf0ecab781f46a58003e69574",
  "utility-credential-app-v0 0.4.3": "87d6bfac3adf937cf5f603767f440a3b60416c2dfd9f82346455547972f5e236",
  "utility-commercials-v0 0.4.2": "2c040e5fa1500ff9d70350875e2a5fb4bf2c75cc7b65f0faa33d01d47393034a",
};

const APP = "#utility-registry-app-v0:Utility.Registry.App.V0";
const REG = "#utility-registry-v0:Utility.Registry.V0";
export const T = {
  operatorConfig: `${APP}.Configuration.Operator:OperatorConfiguration`,
  providerConfig: `${APP}.Configuration.Provider:ProviderConfiguration`,
  providerRequest: `${APP}.Service.Provider:ProviderServiceRequest`,
  providerService: `${APP}.Service.Provider:ProviderService`,
  registrarRequest: `${APP}.Service.Registrar:RegistrarServiceRequest`,
  registrarService: `${APP}.Service.Registrar:RegistrarService`,
  allocationFactory: `${APP}.Service.AllocationFactory:AllocationFactory`,
  mintOffer: `${APP}.Model.Mint:MintOffer`,
  instrumentConfig: `${REG}.Configuration.Instrument:InstrumentConfiguration`,
  transferRule: `${REG}.Rule.Transfer:TransferRule`,
};

/** Ledger client that pins the package versions hosted-backend understands. */
export function pinnedLedger(url: string): Ledger {
  return new Ledger(url, Object.values(BACKEND_PACKAGES));
}

function find(contracts: ActiveContract[], fields: Record<string, string>): string | undefined {
  return contracts.find((c) => Object.entries(fields).every(([k, v]) => c.arg[k] === v))?.cid;
}

function pick(tx: Json, entity: string): string {
  const c = created(tx).find((e) => e.templateId.endsWith(`:${entity}`));
  if (!c) throw new Error(`expected a created ${entity}`);
  return c.contractId;
}

/** Registry parties and the participants they are hosted on. */
export interface RegistryParties {
  operatorLedger: Ledger;
  operator: string;
  providerLedger: Ledger;
  provider: string; // also the registrar
}

/** Onboard `provider` as provider and registrar under `operator`; register the given instruments. */
export async function onboardRegistrar(parties: RegistryParties, instruments: string[]): Promise<void> {
  const { operatorLedger, operator: o, providerLedger, provider: p } = parties;
  const log = (done: boolean, what: string) => console.log(`[${done ? "exists" : "created"}]${done ? " " : ""} ${what}`);

  // 1. OperatorConfiguration (operator)
  let opCfg = find(await operatorLedger.active(o, T.operatorConfig), { operator: o });
  log(!!opCfg, "OperatorConfiguration (operator)");
  opCfg ??= await operatorLedger.create(o, T.operatorConfig, { operator: o, providerRequirements: [] });

  // 2. ProviderService: the provider requests it, the operator accepts on its own participant
  let provSvc = find(await providerLedger.active(p, T.providerService), { operator: o, provider: p });
  log(!!provSvc, "ProviderService (provider requests, operator accepts)");
  if (!provSvc) {
    const req =
      find(await providerLedger.active(p, T.providerRequest), { operator: o, provider: p }) ??
      (await providerLedger.create(p, T.providerRequest, { operator: o, provider: p }));
    await eventually("the ProviderServiceRequest on the operator's participant", async () =>
      find(await operatorLedger.active(o, T.providerRequest), { operator: o, provider: p }),
    );
    const { tx } = await operatorLedger.exercise(o, T.providerRequest, req, "ProviderServiceRequest_Accept", {
      operatorConfigurationCid: opCfg,
      credentialCids: [],
      appRewardConfigurationDetails: null,
    });
    const cid = pick(tx, "ProviderService");
    provSvc = await eventually("the ProviderService on the provider's participant", async () =>
      find(await providerLedger.active(p, T.providerService), { operator: o, provider: p }) === cid ? cid : undefined,
    );
  }

  // 3. ProviderConfiguration (provider)
  let provCfg = find(await providerLedger.active(p, T.providerConfig), { operator: o, provider: p });
  log(!!provCfg, "ProviderConfiguration");
  if (!provCfg) {
    const { tx } = await providerLedger.exercise(p, T.providerService, provSvc, "ProviderService_CreateProviderConfiguration", {
      registrarRequirements: [],
      holderRequirements: [],
    });
    provCfg = pick(tx, "ProviderConfiguration");
  }

  // 4. RegistrarService (+ TransferRule, AllocationFactory): registrar requests, provider accepts
  let regSvc = find(await providerLedger.active(p, T.registrarService), { operator: o, provider: p, registrar: p });
  log(!!regSvc, "RegistrarService, TransferRule, AllocationFactory");
  if (!regSvc) {
    const req =
      find(await providerLedger.active(p, T.registrarRequest), { operator: o, provider: p, registrar: p }) ??
      (await providerLedger.create(p, T.registrarRequest, {
        operator: o, provider: p, registrar: p,
        createTransferRule: true, createAllocationFactory: true,
      }));
    const { tx } = await providerLedger.exercise(p, T.providerService, provSvc, "ProviderService_AcceptRegistrarServiceRequest", {
      cid: req,
      payload: { providerConfigurationCid: provCfg, credentialCids: [] },
    });
    regSvc = pick(tx, "RegistrarService");
  }

  // 5. Instruments (registrar)
  const existing = new Set(
    (await providerLedger.active(p, T.instrumentConfig))
      .filter((c) => c.arg.registrar === p && c.arg.operator === o)
      .map((c) => c.arg.defaultIdentifier.id),
  );
  for (const instrumentId of new Set(instruments)) {
    log(existing.has(instrumentId), `InstrumentConfiguration ${instrumentId}`);
    if (existing.has(instrumentId)) continue;
    await providerLedger.exercise(p, T.registrarService, regSvc, "RegistrarService_CreateInstrumentConfiguration", {
      instrumentId,
      additionalIdentifiers: [],
      issuerRequirements: [],
      holderRequirements: [],
      useBlockList: null,
    });
  }
}
