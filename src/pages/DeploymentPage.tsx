import { useEffect, useState, type ChangeEvent, type ComponentType } from "react";
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
  createFundingStorage,
  createMarketStorage,
  createProjectsStorage,
  createTokenStorage,
  getErrorMessage,
} from "../shared/contracts";
import { isValidAddress, useWallet } from "../shared/tezos";
import { parseUnits } from "../shared/units";

type DeploymentKind = "token" | "dex" | "delegator" | "market" | "funding" | "projects";
type FormValues = Record<string, string>;

const DEFAULT_VALUES: Record<DeploymentKind, FormValues> = {
  token: {},
  dex: { tokenId: "0", feeBps: "30" },
  delegator: { quorumBps: "5000" },
  market: { tokenId: "0", maxPriceAge: "3600" },
  funding: { tokenId: "0", lateFeeBpsPerDay: "100", maxMilestones: "20" },
  projects: { tokenId: "0", graceDays: "7" },
};

const PAGE_TEXT: Record<DeploymentKind, { title: string; subtitle: string; section: string }> = {
  token: {
    title: "Deploy FT (FA2) Contract",
    subtitle: "Connect a wallet, pick a network, paste your compiled Michelson (.tz) code, and originate.",
    section: "3. Token Details",
  },
  dex: {
    title: "Deploy Token <-> XTZ DEX Contract",
    subtitle: "Connect a wallet, configure the token pool and delegator vault, then originate the constant-product DEX.",
    section: "3. DEX Configuration",
  },
  delegator: {
    title: "Deploy BRODelegator Vault",
    subtitle: "Connect a wallet, configure the vault administrator and voting quorum, then originate the delegator contract.",
    section: "3. Delegator Configuration",
  },
  market: {
    title: "Deploy BROMarketAssistant",
    subtitle: "Connect a wallet, configure the price oracle and BRO reserve, then originate the market assistant.",
    section: "3. Market Configuration",
  },
  funding: {
    title: "Deploy BROFunding",
    subtitle: "Connect a wallet, link the market assistant and BRO token, then originate the contract that lists projects and collects investor BRO.",
    section: "3. Funding Configuration",
  },
  projects: {
    title: "Deploy BROProjects",
    subtitle: "Connect a wallet, link BROFunding, the market assistant and BRO token, then originate the contract that runs milestones, repayment and settlement.",
    section: "3. Projects Configuration",
  },
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

function validateMarketForm(values: FormValues, connectedAddress: string) {
  const admin = values.adminAddress?.trim() || connectedAddress;
  const oracle = values.oracleAddress?.trim() || connectedAddress;
  const dex = values.dexAddress?.trim() ?? "";
  const tokenAddress = values.tokenAddress?.trim() ?? "";
  const tokenId = Number(values.tokenId);
  const maxPriceAge = Number(values.maxPriceAge);

  if (!isValidAddress(tokenAddress)) {
    return { error: "Enter a valid BRO FA2 token contract address." };
  }
  if (!isValidAddress(dex)) {
    return { error: "Enter a valid BRODex contract address." };
  }
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    return { error: "Token ID must be a non-negative integer." };
  }
  if (!Number.isInteger(maxPriceAge) || maxPriceAge <= 0) {
    return { error: "Max price age must be a positive number of seconds." };
  }
  if (!isValidAddress(admin)) {
    return { error: "Invalid admin address." };
  }
  if (!isValidAddress(oracle)) {
    return { error: "Invalid oracle address." };
  }

  return { value: { admin, oracle, dex, tokenAddress, tokenId, maxPriceAge } };
}

function validateFundingForm(values: FormValues, connectedAddress: string) {
  const admin = values.adminAddress?.trim() || connectedAddress;
  const market = values.marketAddress?.trim() ?? "";
  const tokenAddress = values.tokenAddress?.trim() ?? "";
  const tokenId = Number(values.tokenId);
  const lateFeeBpsPerDay = Number(values.lateFeeBpsPerDay);
  const maxMilestones = Number(values.maxMilestones);

  if (!isValidAddress(market)) {
    return { error: "Enter a valid BROMarketAssistant contract address." };
  }
  if (!isValidAddress(tokenAddress)) {
    return { error: "Enter a valid BRO FA2 token contract address." };
  }
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    return { error: "Token ID must be a non-negative integer." };
  }
  if (!Number.isInteger(lateFeeBpsPerDay) || lateFeeBpsPerDay < 0 || lateFeeBpsPerDay > 10000) {
    return { error: "Late fee must be between 0 and 10000 basis points per day." };
  }
  if (!Number.isInteger(maxMilestones) || maxMilestones < 1) {
    return { error: "Max milestones must be at least 1." };
  }
  if (!isValidAddress(admin)) {
    return { error: "Invalid admin address." };
  }

  return { value: { admin, market, tokenAddress, tokenId, lateFeeBpsPerDay, maxMilestones } };
}

function validateProjectsForm(values: FormValues, connectedAddress: string) {
  const admin = values.adminAddress?.trim() || connectedAddress;
  const funding = values.fundingAddress?.trim() ?? "";
  const market = values.marketAddress?.trim() ?? "";
  const tokenAddress = values.tokenAddress?.trim() ?? "";
  const tokenId = Number(values.tokenId);
  const graceDays = Number(values.graceDays);

  if (!isValidAddress(funding)) {
    return { error: "Enter a valid BROFunding contract address." };
  }
  if (!isValidAddress(market)) {
    return { error: "Enter a valid BROMarketAssistant contract address." };
  }
  if (!isValidAddress(tokenAddress)) {
    return { error: "Enter a valid BRO FA2 token contract address." };
  }
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    return { error: "Token ID must be a non-negative integer." };
  }
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    return { error: "Grace period must be a non-negative number of days." };
  }
  if (!isValidAddress(admin)) {
    return { error: "Invalid admin address." };
  }

  return { value: { admin, funding, market, tokenAddress, tokenId, graceDays } };
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

function MarketFields({ values, onChange }: FieldSetProps) {
  return <>
    <Field label="BRO token contract address">
      <TextInput value={values.tokenAddress ?? ""} onChange={onChange("tokenAddress")} placeholder="KT1..." />
      <p className="hint">The FA2 contract of the BRO token held in the reserve.</p>
    </Field>
    <Field label="Token ID">
      <TextInput type="number" value={values.tokenId ?? "0"} onChange={onChange("tokenId")} min="0" />
    </Field>
    <Field label="BRODex address">
      <TextInput value={values.dexAddress ?? ""} onChange={onChange("dexAddress")} placeholder="KT1..." />
      <p className="hint">The BRO/XTZ DEX the admin trades the reserve against.</p>
    </Field>
    <Field label="Oracle address">
      <TextInput value={values.oracleAddress ?? ""} onChange={onChange("oracleAddress")} placeholder="Defaults to the connected wallet" />
      <p className="hint">The system wallet allowed to push the BRO/USD price.</p>
    </Field>
    <Field label="Max price age (seconds)">
      <TextInput type="number" value={values.maxPriceAge ?? "3600"} onChange={onChange("maxPriceAge")} min="1" />
      <p className="hint">BROFunding and BROProjects refuse prices older than this. 3600 = 1 hour.</p>
    </Field>
    <Field label="Admin address">
      <TextInput value={values.adminAddress ?? ""} onChange={onChange("adminAddress")} placeholder="Defaults to the connected wallet" />
      <p className="hint">Links BROProjects (<code>set_ledger</code>), changes the oracle, and manages the reserve.</p>
    </Field>
  </>;
}

function FundingFields({ values, onChange }: FieldSetProps) {
  return <>
    <Field label="Market assistant address">
      <TextInput value={values.marketAddress ?? ""} onChange={onChange("marketAddress")} placeholder="KT1..." />
      <p className="hint">The BROMarketAssistant whose BRO/USD price values investor deposits.</p>
    </Field>
    <Field label="BRO token contract address">
      <TextInput value={values.tokenAddress ?? ""} onChange={onChange("tokenAddress")} placeholder="KT1..." />
      <p className="hint">Must be the same token as the market assistant's.</p>
    </Field>
    <Field label="Token ID">
      <TextInput type="number" value={values.tokenId ?? "0"} onChange={onChange("tokenId")} min="0" />
    </Field>
    <Field label="Late fee (basis points per day)">
      <TextInput type="number" value={values.lateFeeBpsPerDay ?? "100"} onChange={onChange("lateFeeBpsPerDay")} min="0" max="10000" />
      <p className="hint">Snapshotted into each project at submission and deducted from a milestone's payout for each day it is approved late. 100 bps = 1% per day.</p>
    </Field>
    <Field label="Max milestones per project">
      <TextInput type="number" value={values.maxMilestones ?? "20"} onChange={onChange("maxMilestones")} min="1" />
    </Field>
    <Field label="Admin address">
      <TextInput value={values.adminAddress ?? ""} onChange={onChange("adminAddress")} placeholder="Defaults to the connected wallet" />
      <p className="hint">Links BROProjects once, cancels submissions, sets the late fee, and can pause funding.</p>
    </Field>
  </>;
}

function ProjectsFields({ values, onChange }: FieldSetProps) {
  return <>
    <Field label="BROFunding address">
      <TextInput value={values.fundingAddress ?? ""} onChange={onChange("fundingAddress")} placeholder="KT1..." />
      <p className="hint">The only contract allowed to launch projects here. It cannot be changed after origination.</p>
    </Field>
    <Field label="Market assistant address">
      <TextInput value={values.marketAddress ?? ""} onChange={onChange("marketAddress")} placeholder="KT1..." />
      <p className="hint">Provides the price and covers shortfalls. Use the same market as BROFunding.</p>
    </Field>
    <Field label="BRO token contract address">
      <TextInput value={values.tokenAddress ?? ""} onChange={onChange("tokenAddress")} placeholder="KT1..." />
      <p className="hint">Must be the same token as BROFunding and the market assistant.</p>
    </Field>
    <Field label="Token ID">
      <TextInput type="number" value={values.tokenId ?? "0"} onChange={onChange("tokenId")} min="0" />
    </Field>
    <Field label="Grace period (days)">
      <TextInput type="number" value={values.graceDays ?? "7"} onChange={onChange("graceDays")} min="0" />
      <p className="hint">Days past a milestone due date or the term end before a project can be marked as defaulted.</p>
    </Field>
    <Field label="Admin address">
      <TextInput value={values.adminAddress ?? ""} onChange={onChange("adminAddress")} placeholder="Defaults to the connected wallet" />
      <p className="hint">Approves milestones, sets the approver NFT and grace period, and can pause the contract.</p>
    </Field>
  </>;
}

const FIELDS: Record<DeploymentKind, ComponentType<FieldSetProps>> = {
  token: TokenFields,
  dex: DexFields,
  delegator: DelegatorFields,
  market: MarketFields,
  funding: FundingFields,
  projects: ProjectsFields,
};

export function DeploymentPage({ kind }: { kind: DeploymentKind }) {
  const wallet = useWallet();
  const [code, setCode] = useState("");
  const [messages, setMessages] = useState(["Idle."]);
  const [deploying, setDeploying] = useState(false);
  const [values, setValues] = useState<FormValues>(DEFAULT_VALUES[kind]);
  const text = PAGE_TEXT[kind];
  const Fields = FIELDS[kind];

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
      if (kind === "token") {
        const result = validateTokenForm(values);
        if (result.error || !result.value) {
          log(result.error ?? "Enter valid token details.");
          return;
        }
        storage = createTokenStorage(wallet.address, result.value);
      } else if (kind === "dex") {
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
      } else if (kind === "delegator") {
        const result = validateDelegatorForm(values, wallet.address);
        if (result.error || !result.value) {
          log(result.error ?? "Enter valid delegator details.");
          return;
        }
        storage = createDelegatorStorage(result.value.admin, result.value.quorumBps);
      } else if (kind === "market") {
        const result = validateMarketForm(values, wallet.address);
        if (result.error || !result.value) {
          log(result.error ?? "Enter valid market details.");
          return;
        }
        storage = createMarketStorage(result.value);
      } else if (kind === "funding") {
        const result = validateFundingForm(values, wallet.address);
        if (result.error || !result.value) {
          log(result.error ?? "Enter valid funding details.");
          return;
        }
        storage = createFundingStorage(result.value);
      } else {
        const result = validateProjectsForm(values, wallet.address);
        if (result.error || !result.value) {
          log(result.error ?? "Enter valid projects details.");
          return;
        }
        storage = createProjectsStorage(result.value);
      }

      log("Sending origination...");
      const operation = await toolkit.wallet.originate({ code: parsedCode, storage }).send();
      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();

      const contract = await operation.contract();
      log(`Deployed! Contract address: ${contract.address}`);
      log(`${wallet.selected.explorer}/${contract.address}`);
    } catch (error) {
      console.error(error);
      log(`Deploy failed: ${getErrorMessage(error)}`);
    } finally {
      setDeploying(false);
    }
  }

  return <Page title={text.title} subtitle={text.subtitle}>
    <NetworkWallet wallet={wallet} />
    <Section title={text.section}>
      <Fields values={values} onChange={updateValue} />
    </Section>
    <Section title="4. Compiled Contract (.tz Michelson)">
      <ContractCode url={CONTRACT_CODE_URLS[kind]} value={code} onChange={setCode} />
    </Section>
    {kind === "dex" && <div className="note">
      <strong>After deploying:</strong> use the pool setup page to link the vault with <code>set_dex</code>, authorize the DEX as an operator on the token contract, and call <code>initialize_pool</code> (sending XTZ) to seed liquidity. <a href="/deployment-dex-setup">Open the pool setup page &rarr;</a>
    </div>}
    {kind === "delegator" && <div className="note">
      <strong>Deployment order:</strong> deploy this vault first, deploy the DEX with this vault address, then use the pool setup page to call the vault's one-time <code>set_dex</code> entrypoint.
    </div>}
    {kind === "market" && <div className="note">
      <strong>Deployment order:</strong> 1. this market assistant, 2. <a href="/deployment-funding">BROFunding</a>, 3. <a href="/deployment-projects">BROProjects</a>, then link them and fund the reserve on the <a href="/deployment-projects-setup">projects setup page</a>.
    </div>}
    {kind === "funding" && <div className="note">
      <strong>Next:</strong> deploy <a href="/deployment-projects">BROProjects</a> with this contract's address, then use the <a href="/deployment-projects-setup">projects setup page</a> to call <code>set_projects</code> (one-time). Investments that complete funding fail until it is linked.
    </div>}
    {kind === "projects" && <div className="note">
      <strong>After deploying:</strong> use the <a href="/deployment-projects-setup">projects setup page</a> to link BROFunding (<code>set_projects</code>) and the market (<code>set_ledger</code>) to this contract, fund the BRO reserve, push the first price, and set the approver NFT.
    </div>}
    <LoadingButton className="deploy" loading={deploying} disabled={!wallet.address} onClick={() => void deploy()}>
      Deploy Contract
    </LoadingButton>
    <Status messages={messages} />
  </Page>;
}
