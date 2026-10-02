import { useEffect, useState, type ReactNode } from "react";
import { NETWORKS, useWallet } from "./tezos";

export function NetworkWallet({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  return <>
    <fieldset>
      <legend>1. Network</legend>
      <label htmlFor="network">Network</label>
      <select id="network" value={wallet.network} onChange={(event) => wallet.setNetwork(event.target.value)}>
        {NETWORKS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </fieldset>
    <fieldset>
      <legend>2. Wallet</legend>
      <div className="row">
        {wallet.address
          ? <button className="secondary" onClick={() => void wallet.disconnect()}>Disconnect</button>
          : <button onClick={() => void wallet.connect()}>Connect Wallet</button>}
      </div>
      <div className="wallet-info">
        {wallet.address ? `Connected: ${wallet.address} (${wallet.network})` : ""}
      </div>
    </fieldset>
  </>;
}

export function Page({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <main><h1>{title}</h1><p className="sub">{subtitle}</p>{children}</main>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <fieldset><legend>{title}</legend>{children}</fieldset>;
}

export function Status({ messages }: { messages: string[] }) {
  return <><h3>Status</h3><div className="status">{messages.join("\n")}</div></>;
}

export function ContractCode({ url, value, onChange }: { url: string; value: string; onChange: (value: string) => void }) {
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch(url);
      onChange(response.ok ? await response.text() : "");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return <>
    <div className="row code-head">
      <label htmlFor="contractCode">Fetched from source link</label>
      <button type="button" className="secondary small" onClick={() => void load()} disabled={loading}>Reload</button>
    </div>
    {loading && <p className="hint">Fetching contract code...</p>}
    <textarea id="contractCode" value={value} onChange={(event) => onChange(event.target.value)} readOnly />
  </>;
}