// Temple Wallet's own page <-> extension protocol (the one @temple-wallet/dapp
// uses), implemented here so we don't pull in that package, whose Taquito peer
// dependency is far behind ours.
//
// Why it exists: Beacon base58check-encodes every message, and base58 is
// quadratic in the message length. A BROProjects origination is ~90 KB of
// Michelson JSON, which takes Temple's background service worker many seconds
// of blocking work to decode (it decodes each request twice). Chrome kills the
// worker, Temple's content script loses the request, and Beacon waits forever
// at "Request sent to wallet". Temple's own channel sends plain JSON through
// window.postMessage, so request size stops mattering.

const REQUEST = "TEMPLE_PAGE_REQUEST";
const RESPONSE = "TEMPLE_PAGE_RESPONSE";
const ERROR_RESPONSE = "TEMPLE_PAGE_ERROR_RESPONSE";

type TemplePermission = { rpc: string; pkh: string; publicKey: string } | null;

let nextId = 0;

function request<T = any>(payload: unknown, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const reqId = `bro-${Date.now()}-${nextId++}`;
    const done = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.data?.reqId !== reqId) return;
      if (event.data.type === RESPONSE) {
        done();
        resolve(event.data.payload);
      } else if (event.data.type === ERROR_RESPONSE) {
        done();
        reject(templeError(event.data.payload));
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("Temple Wallet did not answer. Check that it is unlocked, then try again."));
    }, timeoutMs);
    window.addEventListener("message", onMessage);
    window.postMessage({ type: REQUEST, payload, reqId }, window.origin);
  });
}

function templeError(payload: unknown) {
  if (payload === "NOT_GRANTED") return new Error("Rejected in Temple Wallet (NOT_GRANTED).");
  if (payload === "NOT_FOUND") return new Error("Temple Wallet does not have this account connected to this site (NOT_FOUND).");
  if (payload === "INVALID_PARAMS") return new Error("Temple Wallet rejected the operation parameters (INVALID_PARAMS).");
  // A failed simulation arrives as ["TEZOS_OPERATION", errors].
  if (Array.isArray(payload) && payload[0] === "TEZOS_OPERATION") {
    return Object.assign(new Error("The operation failed in Temple Wallet's simulation."), { errors: payload[1] });
  }
  return new Error(`Temple Wallet error: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
}

/** True when the Temple extension answers on its own channel. */
export async function templeAvailable(): Promise<boolean> {
  try {
    return (await request("PING", 500)) === "PONG";
  } catch {
    return false;
  }
}

/**
 * Makes sure Temple has granted this site `pkh` on its own channel. Temple keeps
 * one permission per site for both channels, so a Beacon connection to Temple
 * already counts and this normally returns without a prompt.
 */
export async function ensureTemplePermission(pkh: string, network: string, appName: string) {
  const current = await request<{ permission: TemplePermission }>({ type: "GET_CURRENT_PERMISSION_REQUEST" }, 10_000);
  if (current?.permission?.pkh === pkh) return;
  const granted = await request<{ pkh: string }>({
    type: "PERMISSION_REQUEST",
    network,
    appMeta: { name: appName },
    force: false,
  }, 10 * 60_000);
  if (granted?.pkh !== pkh) {
    throw new Error(`Temple Wallet is connected with ${granted?.pkh}, not ${pkh}. Reconnect the wallet on this page.`);
  }
}

/**
 * Sends Beacon-format operation details (what BeaconWallet's map*Params
 * functions produce) through Temple's channel. Returns the operation hash.
 */
export async function sendTempleOperations(pkh: string, operations: any[], timeoutMs: number): Promise<string> {
  const opParams = operations.map(toTempleParams);
  const response = await request<{ opHash: string }>({ type: "OPERATION_REQUEST", sourcePkh: pkh, opParams }, timeoutMs);
  if (!response?.opHash) throw new Error("Temple Wallet returned no operation hash.");
  return response.opHash;
}

// Same conversion Temple applies to Beacon requests (lib/temple/beacon.ts formatOpParams).
function toTempleParams(op: any) {
  const { fee, gas_limit, storage_limit, ...rest } = op;
  const limits = { fee, gasLimit: gas_limit, storageLimit: storage_limit };
  if (op.kind === "transaction") {
    const { destination, amount, parameters, ...txRest } = rest;
    return { ...txRest, to: destination, amount: +amount, mutez: true, parameter: parameters, ...limits };
  }
  if (op.kind === "origination") return { ...rest, mutez: true, ...limits };
  return { ...rest, ...limits };
}
