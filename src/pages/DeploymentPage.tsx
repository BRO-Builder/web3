import { useEffect, useState, type ChangeEvent } from "react";
import { Parser } from "@taquito/michel-codec";

import {
  ContractCode,
  LoadingButton,
  NetworkWallet,
  Page,
  Section,
  Status,
} from "../shared/Controls";
import { Field, TextArea, TextInput } from "../shared/FormField";
import {
  CONTRACT_CODE_URLS,
  createDelegatorStorage,
  createDexStorage,
  createTokenStorage,
  getErrorMessage,
} from "../shared/contracts";
import { isValidAddress, useWallet } from "../shared/tezos";
import { parseUnits } from "../shared/units";

type DeploymentKind = "token" | "dex" | "delegator";
type FormValues = Record<string, string>;

const DEFAULT_VALUES: Record<DeploymentKind, FormValues> = {
  token: {},
  dex: { tokenId: "0", feeBps: "30" },
  delegator: { quorumBps: "5000" },
};

function validateTokenForm(values: FormValues) {
  const name = values.name?.trim();
  const symbol = values.symbol?.trim();
  const decimals = Number(values.decimals);
  const supply = name && symbol && Number.isInteger(decimals) && decimals >= 0
    ? parseUnits(values.supply ?? "", decimals)
    : null;

  if (!name || !symbol || !Number.isInteger(decimals) || decimals < 0) {
    return { error: "Enter a valid token name, symbol, and decimals." };
  }
  if (!supply || supply <= 0n) {
    return { error: `Total supply must be positive and use at most ${decimals} decimal places.` };
  }

  return {
    value: {
      name,
      symbol,
      decimals,
      supply,
      description: values.description,
      thumbnail: values.thumbnail,
    },
  };
}

function validateDexForm(values: FormValues, connectedAddress: string) {
  const tokenAddress = values.tokenAddress?.trim() ?? "";
  const vault = values.vaultAddress?.trim() ?? "";
  const tokenId = Number(values.tokenId);
  const feeBps = Number(values.feeBps);
  const admin = values.adminAddress?.trim() || connectedAddress;

  if (!isValidAddress(tokenAddress)) {
    return { error: "Enter a valid FA2 token contract address." };
  }
  if (!isValidAddress(vault)) {
    return { error: "Enter a valid BRODelegator vault contract address." };
  }
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    return { error: "Token ID must be a non-negative integer." };
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
    return { error: "Fee must be between 0 and 10000 basis points." };
  }
  if (!isValidAddress(admin)) {
    return { error: "Invalid admin address." };
  }

  return { value: { tokenAddress, tokenId, feeBps, vault, admin } };
}

function validateDelegatorForm(values: FormValues, connectedAddress: string) {
  const admin = values.adminAddress?.trim() || connectedAddress;
  const quorumBps = Number(values.quorumBps);

  if (!isValidAddress(admin)) {
    return { error: "Invalid admin address." };
  }
  if (!Number.isInteger(quorumBps) || quorumBps < 0 || quorumBps > 10000) {
    return { error: "Quorum must be between 0 and 10000 basis points." };
  }

  return { value: { admin, quorumBps } };
}

type FieldSetProps = {
  values: FormValues;
  onChange: (name: string) => (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
};

function TokenFields({ values, onChange }: FieldSetProps) {
  return <>
    <Field label="Token name">
      <TextInput value={values.name ?? ""} onChange={onChange("name")} placeholder="e.g. BRO Builder Token" />
    </Field>
    <Field label="Token symbol">
      <TextInput value={values.symbol ?? ""} onChange={onChange("symbol")} placeholder="e.g. BRO" />
    </Field>
    <Field label="Token decimals">
      <TextInput type="number" value={values.decimals ?? ""} onChange={onChange("decimals")} min="0" />
    </Field>
    <Field label="Total supply (eg. 20000.123 for 20k tokens with 3 decimals)">
      <TextInput type="number" value={values.supply ?? ""} onChange={onChange("supply")} placeholder="1000000" min="0" step="any" />
    </Field>
    <Field label="Token description">
      <TextArea value={values.description ?? ""} onChange={onChange("description")} placeholder="e.g. A utility token for the BRO Builder platform." />
    </Field>
    <Field label="Token thumbnail URL">
      <TextInput value={values.thumbnail ?? ""} onChange={onChange("thumbnail")} placeholder="e.g. https://www.brobuilder.llc/images/token-thumbnail.png" />
    </Field>
  </>;
}

function DexFields({ values, onChange }: FieldSetProps) {
  return <>
    <Field label="Delegator vault address">
      <TextInput value={values.vaultAddress ?? ""} onChange={onChange("vaultAddress")} placeholder="KT1..." />
      <p className="hint">The BRODelegator contract that will hold and delegate the DEX's XTZ.</p>
    </Field>
    <Field label="Token contract address">
      <TextInput value={values.tokenAddress ?? ""} onChange={onChange("tokenAddress")} placeholder="KT1..." />
      <p className="hint">The FA2 contract whose token will be paired with XTZ.</p>
    </Field>
    <Field label="Token ID">
      <TextInput type="number" value={values.tokenId ?? "0"} onChange={onChange("tokenId")} min="0" />
    </Field>
    <Field label="Swap fee (basis points)">
      <TextInput type="number" value={values.feeBps ?? "30"} onChange={onChange("feeBps")} min="0" max="10000" />
      <p className="hint">100 bps = 1%. The fee stays in the pool and accrues to liquidity providers when they redeem their shares.</p>
    </Field>
    <Field label="Admin address">
      <TextInput value={values.adminAddress ?? ""} onChange={onChange("adminAddress")} placeholder="Defaults to the connected wallet" />
      <p className="hint">Can change the fee and transfer admin rights.</p>
    </Field>
  </>;
}

function DelegatorFields({ values, onChange }: FieldSetProps) {
  return <>
    <Field label="Admin address">
      <TextInput value={values.adminAddress ?? ""} onChange={onChange("adminAddress")} placeholder="Defaults to the connected wallet" />
      <p className="hint">Can update the vault configuration and link the DEX once.</p>
    </Field>
    <Field label="Voting quorum (basis points)">
      <TextInput type="number" value={values.quorumBps ?? "5000"} onChange={onChange("quorumBps")} min="0" max="10000" />
      <p className="hint">The candidate baker must receive this share of total LP votes. 5000 bps = 50%.</p>
    </Field>
  </>;
}

export function DeploymentPage({ kind }: { kind: DeploymentKind }) {
  const wallet = useWallet();
  const [code, setCode] = useState("");
  const [messages, setMessages] = useState(["Idle."]);
  const [deploying, setDeploying] = useState(false);
  const [values, setValues] = useState<FormValues>(DEFAULT_VALUES[kind]);
  const isToken = kind === "token";
  const isDex = kind === "dex";

  useEffect(() => {
    setCode("");
    setValues(DEFAULT_VALUES[kind]);
  }, [kind]);

  function log(message: string) {
    setMessages((current) => [...current, message]);
  }

  function updateValue(name: string) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValues((current) => ({ ...current, [name]: event.target.value }));
    };
  }

  async function deploy() {
    if (!wallet.address) {
      log("Connect a wallet first.");
      return;
    }
    if (!code) {
      log("Contract code has not been loaded. Click Reload.");
      return;
    }

    setDeploying(true);
    try {
      const { toolkit } = await wallet.ensureWallet();
      const parsedCode = new Parser().parseScript(code);
      if (!parsedCode) {
        log("Contract code could not be parsed.");
        return;
      }

      let storage;
      if (isToken) {
        const result = validateTokenForm(values);
        if (result.error || !result.value) {
          log(result.error ?? "Enter valid token details.");
          return;
        }
        storage = createTokenStorage(wallet.address, result.value);
      } else if (isDex) {
        const result = validateDexForm(values, wallet.address);
        if (result.error || !result.value) {
          log(result.error ?? "Enter valid DEX details.");
          return;
        }
        storage = createDexStorage(
          result.value.tokenAddress,
          result.value.tokenId,
          result.value.feeBps,
          result.value.vault,
          result.value.admin,
        );
      } else {
        const result = validateDelegatorForm(values, wallet.address);
        if (result.error || !result.value) {
          log(result.error ?? "Enter valid delegator details.");
          return;
        }
        storage = createDelegatorStorage(result.value.admin, result.value.quorumBps);
      }

      log("Sending origination...");
      const operation = await toolkit.wallet.originate({ code: parsedCode, storage }).send();
      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();

      const contract = await operation.contract();
      log(`Deployed! Contract address: ${contract.address}`);
      log(`${wallet.selected.explorer}/${contract.address}`);
    } catch (error) {
      log(`Deploy failed: ${getErrorMessage(error)}`);
    } finally {
      setDeploying(false);
    }
  }

  return <Page
    title={isToken
      ? "Deploy FT (FA2) Contract"
      : isDex ? "Deploy Token <-> XTZ DEX Contract" : "Deploy BRODelegator Vault"}
    subtitle={isToken
      ? "Connect a wallet, pick a network, paste your compiled Michelson (.tz) code, and originate."
      : isDex
        ? "Connect a wallet, configure the token pool and delegator vault, then originate the constant-product DEX."
        : "Connect a wallet, configure the vault administrator and voting quorum, then originate the delegator contract."}
  >
    <NetworkWallet wallet={wallet} />
    <Section title={isToken ? "3. Token Details" : isDex ? "3. DEX Configuration" : "3. Delegator Configuration"}>
      {isToken
        ? <TokenFields values={values} onChange={updateValue} />
        : isDex ? <DexFields values={values} onChange={updateValue} /> : <DelegatorFields values={values} onChange={updateValue} />}
    </Section>
    <Section title="4. Compiled Contract (.tz Michelson)">
      <ContractCode url={CONTRACT_CODE_URLS[kind]} value={code} onChange={setCode} />
    </Section>
    {isDex && <div className="note">
      <strong>After deploying:</strong> use the pool setup page to link the vault with <code>set_dex</code>, authorize the DEX as an operator on the token contract, and call <code>initialize_pool</code> (sending XTZ) to seed liquidity. <a href="/deployment-dex-setup">Open the pool setup page &rarr;</a>
    </div>}
    {kind === "delegator" && <div className="note">
      <strong>Deployment order:</strong> deploy this vault first, deploy the DEX with this vault address, then use the pool setup page to call the vault's one-time <code>set_dex</code> entrypoint.
    </div>}
    <LoadingButton className="deploy" loading={deploying} disabled={!wallet.address} onClick={() => void deploy()}>
      Deploy Contract
    </LoadingButton>
    <Status messages={messages} />
  </Page>;
}
