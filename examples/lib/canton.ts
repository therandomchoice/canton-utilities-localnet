// Minimal clients for the localnet: participant JSON Ledger API (v2), Splice wallet API,
// Utilities hosted-backend. No dependencies: Node's built-in fetch and crypto only.
import { createHmac, randomUUID } from "node:crypto";

export type Json = any;

/** Localnet endpoints of one validator. */
export interface Node {
  name: string;
  jsonApi: string; // participant JSON Ledger API
  validatorApi: string; // Splice validator API (wallet lives under /api/validator/v0/wallet)
  utilities: string; // nginx: Utilities API and Token Standard off-ledger API of this node's hosted-backend
  walletUser: string; // wallet user (validator-wallet-users) whose wallet holds the validator party
}

export const APP_PROVIDER: Node = {
  name: "app-provider",
  jsonApi: "http://localhost:3975",
  validatorApi: "http://localhost:3903",
  utilities: "http://utility.localhost:3000",
  walletUser: "app-provider",
};

export const SV: Node = {
  name: "sv",
  jsonApi: "http://localhost:4975",
  validatorApi: "http://localhost:4903",
  utilities: "http://utility.localhost:4000",
  walletUser: "sv",
};

/** Party id hint of the Utilities registry operator on the sv participant (see tools/party-ids.sh). */
export const UTILITY_OPERATOR_HINT = "utility-operator";

export const APP_USER: Node = {
  name: "app-user",
  jsonApi: "http://localhost:2975",
  validatorApi: "http://localhost:2903",
  utilities: "http://utility.localhost:2000",
  walletUser: "app-user",
};

/** User that owns the validator party on every participant (`ledger-api-user`). */
export const LEDGER_API_USER = "ledger-api-user";

/** HS256 JWT signed with the localnet "unsafe" secret, as accepted by participants and validators. */
export function token(sub: string, aud = "https://canton.network.global"): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, aud })}`;
  return `${unsigned}.${createHmac("sha256", "unsafe").update(unsigned).digest("base64url")}`;
}

export async function http(method: string, url: string, body?: Json, bearer?: string): Promise<Json> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const resp = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${url} failed: HTTP ${resp.status}\n${text}`);
  return text ? JSON.parse(text) : {};
}

/** Disclosed contract as returned by registry APIs (Token Standard / Utilities). */
export interface Disclosed {
  contractId: string;
  templateId: string;
  createdEventBlob: string;
  synchronizerId?: string;
}

export interface ActiveContract {
  cid: string;
  templateId: string;
  arg: Json;
}

/** Participant JSON Ledger API v2, acting as `ledger-api-user`. */
export class Ledger {
  readonly url: string;
  readonly packages: string[];
  private readonly bearer = token(LEDGER_API_USER);

  /** packages: package ids to prefer when the participant has several versions of a package. */
  constructor(url: string, packages: string[] = []) {
    this.url = url.replace(/\/$/, "");
    this.packages = packages;
  }

  call(method: string, path: string, body?: Json): Promise<Json> {
    return http(method, this.url + path, body, this.bearer);
  }

  /** The validator party: primary party of `ledger-api-user`. */
  async validatorParty(): Promise<string> {
    const { user } = await this.call("GET", `/v2/users/${LEDGER_API_USER}`);
    if (!user.primaryParty) throw new Error(`${LEDGER_API_USER} has no primary party on ${this.url}`);
    return user.primaryParty;
  }

  /** A party `ledger-api-user` can act as whose id starts with `hint::`. */
  async partyByHint(hint: string): Promise<string> {
    const { rights } = await this.call("GET", `/v2/users/${LEDGER_API_USER}/rights`);
    for (const r of rights) {
      const party: string | undefined = r.kind?.CanActAs?.value.party;
      if (party?.startsWith(`${hint}::`)) return party;
    }
    throw new Error(`no party ${hint}::… for ${LEDGER_API_USER} on ${this.url} (run make party-ids)`);
  }

  private async acs(party: string, filter: Json): Promise<Json[]> {
    const { offset } = await this.call("GET", "/v2/state/ledger-end");
    const entries = await this.call("POST", "/v2/state/active-contracts", {
      eventFormat: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: filter }] } }, verbose: false },
      activeAtOffset: offset,
    });
    return entries.map((e: Json) => e.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean);
  }

  /** Active contracts of a template (any package version) visible to party. */
  async active(party: string, templateId: string): Promise<ActiveContract[]> {
    const events = await this.acs(party, {
      TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } },
    });
    return events.map((ev) => ({ cid: ev.contractId, templateId: ev.templateId, arg: ev.createArgument }));
  }

  /** Interface views of active contracts implementing an interface, visible to party. */
  async views(party: string, interfaceId: string): Promise<{ cid: string; view: Json }[]> {
    const events = await this.acs(party, {
      InterfaceFilter: { value: { interfaceId, includeInterfaceView: true, includeCreatedEventBlob: false } },
    });
    return events.flatMap((ev) =>
      (ev.interfaceViews ?? []).filter((v: Json) => v.viewValue).map((v: Json) => ({ cid: ev.contractId, view: v.viewValue })),
    );
  }

  /** Submit commands and wait; returns the transaction with all events (ledger effects shape). */
  async submit(actAs: string[], commands: Json[], disclosed: Disclosed[] = []): Promise<Json> {
    const body = {
      commands: {
        commands,
        commandId: `example-${randomUUID()}`,
        userId: LEDGER_API_USER,
        actAs,
        readAs: [],
        disclosedContracts: disclosed.map((d) => ({
          contractId: d.contractId,
          templateId: d.templateId,
          createdEventBlob: d.createdEventBlob,
          synchronizerId: d.synchronizerId ?? "",
        })),
        packageIdSelectionPreference: this.packages,
      },
      transactionFormat: {
        eventFormat: {
          filtersByParty: Object.fromEntries(actAs.map((p) => [p, { cumulative: [] }])),
          verbose: false,
        },
        transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
      },
    };
    return (await this.call("POST", "/v2/commands/submit-and-wait-for-transaction", body)).transaction;
  }

  /** Create a contract; returns its contract id. */
  async create(actAs: string, templateId: string, createArguments: Json): Promise<string> {
    const tx = await this.submit([actAs], [{ CreateCommand: { templateId, createArguments } }]);
    return created(tx)[0].contractId;
  }

  /** Exercise a choice; returns the choice result and the transaction. */
  async exercise(
    actAs: string,
    templateId: string,
    contractId: string,
    choice: string,
    choiceArgument: Json,
    disclosed: Disclosed[] = [],
  ): Promise<{ result: Json; tx: Json }> {
    const tx = await this.submit(
      [actAs],
      [{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }],
      disclosed,
    );
    const root = tx.events.find((e: Json) => e.ExercisedEvent)?.ExercisedEvent;
    return { result: root?.exerciseResult, tx };
  }
}

/** Created events of a transaction. */
export function created(tx: Json): { templateId: string; contractId: string; arg: Json }[] {
  return (tx.events ?? [])
    .filter((e: Json) => e.CreatedEvent)
    .map((e: Json) => ({
      templateId: e.CreatedEvent.templateId,
      contractId: e.CreatedEvent.contractId,
      arg: e.CreatedEvent.createArgument,
    }));
}

export const short = (s: string) => (s.length > 20 ? `${s.slice(0, 16)}…` : s);

/** Party id shortened for logs: `name::1220abcd…`. */
export const shortParty = (p: string) => p.replace(/::(.{8}).*/, "::$1…");

/** Retry until fn returns a value: another participant sees a transaction slightly later. */
export async function eventually<V>(what: string, fn: () => Promise<V | undefined>): Promise<V> {
  for (let i = 0; i < 30; i++) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}
