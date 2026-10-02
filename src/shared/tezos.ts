import { useEffect, useState } from "react";
import { BeaconWallet } from "@taquito/beacon-wallet";
import { TezosToolkit } from "@taquito/taquito";
import { ValidationResult, validateAddress } from "@taquito/utils";

export const NETWORKS = [
  { label: "ShadowNet (testnet)", value: "shadownet", rpc: "https://rpc.tzkt.io/shadownet", explorer: "https://shadownet.tzkt.io", api: "https://api.shadownet.tzkt.io" },
  { label: "Ghostnet (testnet)", value: "ghostnet", rpc: "https://rpc.tzkt.io/ghostnet", explorer: "https://ghostnet.tzkt.io", api: "https://api.ghostnet.tzkt.io" },
  { label: "Mainnet", value: "mainnet", rpc: "https://rpc.tzkt.io/mainnet", explorer: "https://tzkt.io", api: "https://api.tzkt.io" },
] as const;

export function isValidAddress(value: string) {
  return validateAddress(value) === ValidationResult.VALID;
}

export function useWallet(name: string) {
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
      beacon = new BeaconWallet({ name, iconUrl: "https://www.brobuilder.llc/images/logo2.png", network: { type: network as any } });
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