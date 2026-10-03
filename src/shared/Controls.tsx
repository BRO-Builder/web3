import { useEffect, useState, type ReactNode } from "react";
import { NETWORKS, useWallet } from "./tezos";

export function NetworkWallet({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function connect() {
    setConnecting(true);
    try {
      await wallet.connect();
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    try {
      await wallet.disconnect();
    } finally {
      setDisconnecting(false);
    }
  }

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
          ? <LoadingButton className="secondary" loading={disconnecting} onClick={() => void disconnect()}>Disconnect</LoadingButton>
          : <LoadingButton loading={connecting} onClick={() => void connect()}>Connect Wallet</LoadingButton>}
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

export function LoadingButton({
  loading,
  children,
  disabled,
  className,
  onClick,
}: {
  loading: boolean;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return <button
    className={className}
    disabled={disabled || loading}
    onClick={onClick}
    aria-busy={loading}
  >
    {loading && <span className="button-spinner" aria-hidden="true" />}
    {loading ? "Processing..." : children}
  </button>;
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
      <LoadingButton className="secondary small" loading={loading} onClick={() => void load()}>Reload</LoadingButton>
    </div>
    {loading && <p className="hint">Fetching contract code...</p>}
    <textarea id="contractCode" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Contract code will be fetched automatically..." readOnly />
  </>;
}