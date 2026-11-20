// Amulet transfer: app-provider mints 1000 Amulet and transfers 500 to app-user.
//
//   1. mint     app-provider taps 1000 Amulet (AmuletRules_DevNet_Tap, the DevNet/LocalNet faucet).
//               The wallet's tap amount is in USD: it is divided by the amulet price of the open
//               mining round, so the example converts 1000 Amulet to USD with that price first
//   2. offer    app-provider creates a Token Standard transfer of 500 Amulet to app-user;
//               the Amulet is locked in an AmuletTransferInstruction until the receiver decides
//   3. accept   app-user accepts the transfer instruction and receives the Amulet
//
// Everything goes through the Splice wallet API of each validator (/api/validator/v0/wallet), which
// builds the Ledger API commands, fetches the choice contexts from Scan and submits them.
// Wallet users are the validator-wallet-users of the localnet: "app-provider" and "app-user".
//
// Run: node amulet-transfer.ts
import { APP_PROVIDER, APP_USER, type Json, type Node, http, short, shortParty, token } from "./lib/canton.ts";

const SCAN_API = "http://scan.localhost:4000/api/scan";

const MINT_AMOUNT = "1000";
const TRANSFER_AMOUNT = "500";

class Wallet {
  readonly node: Node;
  private readonly bearer: string;

  constructor(node: Node) {
    this.node = node;
    this.bearer = token(node.walletUser);
  }

  call(method: string, path: string, body?: Json): Promise<Json> {
    return http(method, `${this.node.validatorApi}/api/validator/v0/wallet${path}`, body, this.bearer);
  }

  async party(): Promise<string> {
    return (await this.call("GET", "/user-status")).party_id;
  }

  async balance(): Promise<string> {
    const qty: string = (await this.call("GET", "/balance")).effective_unlocked_qty;
    return qty.includes(".") ? qty.replace(/0+$/, "").replace(/\.$/, "") : qty;
  }
}

const provider = new Wallet(APP_PROVIDER);
const user = new Wallet(APP_USER);

const providerParty = await provider.party();
const userParty = await user.party();
console.log(`provider: ${shortParty(providerParty)}`);
console.log(`user:     ${shortParty(userParty)}`);

const showBalances = async (label: string) =>
  console.log(`[balance] ${label}: provider ${await provider.balance()}, user ${await user.balance()}`);

await showBalances("before");

/** Amulet price (USD per Amulet) of the latest open mining round, the one the wallet uses for tap. */
async function amuletPrice(): Promise<number> {
  const { open_mining_rounds } = await http("POST", `${SCAN_API}/v0/open-and-issuing-mining-rounds`, {
    cached_open_mining_round_contract_ids: [],
    cached_issuing_round_contract_ids: [],
  });
  const now = Date.now();
  const open = Object.values(open_mining_rounds as Record<string, Json>)
    .map((r) => r.contract.payload)
    .filter((p) => Date.parse(p.opensAt) <= now)
    .sort((a, b) => Number(b.round.number) - Number(a.round.number));
  if (!open.length) throw new Error("no open mining round");
  return Number(open[0].amuletPrice);
}

// 1. Mint: on DevNet/LocalNet anyone can tap Amulet from AmuletRules. The wallet API takes the
//    amount in USD and divides it by the round's amulet price, so convert first.
const price = await amuletPrice();
const usd = (Number(MINT_AMOUNT) * price).toFixed(10).replace(/\.?0+$/, "");
const tap = await provider.call("POST", "/tap", { amount: usd });
console.log(`[mint]    ${MINT_AMOUNT} Amulet (tap ${usd} USD at ${price} USD/Amulet) to provider, amulet ${short(tap.contract_id)}`);

// 2. Transfer: Token Standard two-step transfer (TransferFactory_Transfer on the Amulet registry).
const expiresAtMicros = (Date.now() + 60 * 60 * 1000) * 1000;
const transfer = await provider.call("POST", "/token-standard/transfers", {
  receiver_party_id: userParty,
  amount: TRANSFER_AMOUNT,
  description: "amulet-transfer example",
  expires_at: expiresAtMicros,
  tracking_id: `amulet-transfer-${Date.now()}`,
});

const instructionCid: string | undefined = transfer.output.transfer_instruction_cid;
if (!instructionCid) {
  // The receiver has a TransferPreapproval: the transfer completed in one step.
  console.log(`[transfer] ${TRANSFER_AMOUNT} Amulet completed directly (receiver has a transfer preapproval)`);
} else {
  console.log(`[offer]   ${TRANSFER_AMOUNT} Amulet to user, transfer instruction ${short(instructionCid)}`);

  // 3. Accept: the receiver sees the pending transfer in its wallet and accepts it.
  const { transfers } = await user.call("GET", "/token-standard/transfers");
  const incoming = transfers.find((t: Json) => t.contract_id === instructionCid);
  if (!incoming) throw new Error(`transfer instruction ${instructionCid} not visible to the user`);
  const p = incoming.payload.transfer;
  console.log(`[pending] ${p.amount} ${p.instrumentId.id} from ${shortParty(p.sender)}, expires ${p.executeBefore}`);

  const accepted = await user.call("POST", `/token-standard/transfers/${instructionCid}/accept`);
  console.log(`[accept]  user holding ${short(accepted.output.receiver_holding_cids[0])}`);
}

await showBalances("after");
