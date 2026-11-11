import { useEffect, useState } from "react";
import { BeaconWallet } from "@taquito/beacon-wallet";
import { TezosToolkit } from "@taquito/taquito";
import { ValidationResult, validateAddress } from "@taquito/utils";
import { ensureTemplePermission, sendTempleOperations, templeAvailable } from "./templeChannel";

const APP_NAME = "BRO Builder LLC Web3";
// Beacon rejects with PEER_UNREACHABLE when the wallet has not answered
// within 60s by default. Large originations (BROProjects) take Temple
// longer than that to estimate and review.
const REQUEST_TIMEOUT_MS = 10 * 60_000;
// Above this many bytes of operation JSON, Beacon's base58 encoding gets slow
// enough to stall Temple (see templeChannel.ts). BROFunding is ~40 KB and
// BROProjects ~90 KB; ordinary calls are a few KB.
const LARGE_REQUEST_BYTES = 16_000;

/**
 * BeaconWallet that sends large requests to Temple through Temple's own
 * channel instead of Beacon. Everything else, and every other wallet, still
 * goes through Beacon.
 */
class BroBeaconWallet extends BeaconWallet {
  constructor(private readonly networkType: string) {
    super({
      name: APP_NAME,
      iconUrl: "https://www.brobuilder.llc/images/logo2.png",
      network: { type: networkType as any },
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
  }

  async sendOperations(params: any[]): Promise<string> {
    const account = await this.client.getActiveAccount();
    if (account?.origin.type === "extension" && JSON.stringify(params).length > LARGE_REQUEST_BYTES && await templeAvailable()) {
      // mapOriginateParamsToWalletParams showed Beacon's "preparing" alert;
      // Beacon's requestOperation would have replaced it, so clear it here.
      await this.client.hideUI(["alert"]).catch(() => undefined);
      await ensureTemplePermission(account.address, this.networkType, APP_NAME);
      return sendTempleOperations(account.address, params, REQUEST_TIMEOUT_MS);
    }
    return super.sendOperations(params);
  }
}

export const NETWORKS = [
  { label: "ShadowNet (testnet)", value: "shadownet", rpc: "https://rpc.tzkt.io/shadownet", explorer: "https://shadownet.tzkt.io", api: "https://api.shadownet.tzkt.io" },
  { label: "Ghostnet (testnet)", value: "ghostnet", rpc: "https://rpc.tzkt.io/ghostnet", explorer: "https://ghostnet.tzkt.io", api: "https://api.ghostnet.tzkt.io" },
  { label: "Mainnet", value: "mainnet", rpc: "https://rpc.tzkt.io/mainnet", explorer: "https://tzkt.io", api: "https://api.tzkt.io" },
] as const;

export function isValidAddress(value: string) {
  return validateAddress(value) === ValidationResult.VALID;
}

export function useWallet() {
  const [network, setNetwork] = useState("shadownet");
  const [address, setAddress] = useState<string | null>(null);
  const [tezos, setTezos] = useState<TezosToolkit | null>(null);
  const [wallet, setWallet] = useState<BeaconWallet | null>(null);
  const selected = NETWORKS.find((item) => item.value === network) ?? NETWORKS[0];

  useEffect(() => {
    setAddress(null);
    setWallet(null);
    setTezos(null);
  }, [network]);

  async function ensureWallet() {
    let toolkit = tezos;
    let beacon = wallet;
    if (!toolkit) toolkit = new TezosToolkit(selected.rpc);
    else toolkit.setRpcProvider(selected.rpc);
    if (!beacon) {
      beacon = new BroBeaconWallet(network);
      toolkit.setWalletProvider(beacon);
      setTezos(toolkit);
      setWallet(beacon);
    }
    return { toolkit, beacon };
  }

  async function connect() {
    const { beacon } = await ensureWallet();
    await beacon.requestPermissions();
    setAddress(await beacon.getPKH());
  }

  async function disconnect() {
    if (wallet) await wallet.clearActiveAccount();
    setAddress(null);
    setWallet(null);
    setTezos(null);
  }

  return { address, network, setNetwork, selected, connect, disconnect, ensureWallet };
}