import { useState } from "react";
import { LoadingButton, NetworkWallet, Page, Section, Status } from "../shared/Controls";
import { getErrorMessage } from "../shared/contracts";
import { isValidAddress, useWallet } from "../shared/tezos";
import { toBigInt } from "../shared/units";

type TallyEntry = {
  baker: string;
  votes: bigint;
};

type VotingState = {
  delegate: string | null;
  quorumBps: bigint;
  totalShares: bigint;
  myShares: bigint;
  myVote: string | null;
  tally: TallyEntry[];
};

const EMPTY_STATE: VotingState = {
  delegate: null,
  quorumBps: 0n,
  totalShares: 0n,
  myShares: 0n,
  myVote: null,
  tally: [],
};

function shortAddress(address: string | null) {
  return address ? `${address.slice(0, 7)}…${address.slice(-5)}` : "—";
}

function isBakerAddress(address: string) {
  return /^tz[1-3][1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
}

function readOption(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "Some" in value && typeof value.Some === "string") {
    return value.Some;
  }
  return null;
}

function percentage(votes: bigint, total: bigint) {
  return total > 0n ? `${(Number(votes * 10000n / total) / 100).toFixed(2)}%` : "0.00%";
}

export function VotingPage() {
  const wallet = useWallet();
  const [address, setAddress] = useState("");
  const [baker, setBaker] = useState("");
  const [state, setState] = useState(EMPTY_STATE);
  const [messages, setMessages] = useState(["Idle."]);
  const [loadingVault, setLoadingVault] = useState(false);
  const [voting, setVoting] = useState(false);
  const [withdrawingVote, setWithdrawingVote] = useState(false);
  const [updatingDelegate, setUpdatingDelegate] = useState<string | null>(null);

  function log(message: string) {
    setMessages((current) => [...current, message]);
  }

  async function readTally(vaultAddress: string) {
    const response = await fetch(
      `${wallet.selected.api}/v1/contracts/${vaultAddress}/bigmaps/tally/keys?active=true&limit=200`,
    );
    if (!response.ok) throw new Error(`TzKT returned HTTP ${response.status}.`);
    const entries: Array<{ key: string; value: string | number }> = await response.json();
    return entries
      .map((entry) => ({ baker: entry.key, votes: BigInt(String(entry.value)) }))
      .filter((entry) => entry.votes > 0n)
      .sort((left, right) => right.votes > left.votes ? 1 : right.votes < left.votes ? -1 : 0);
  }

  async function loadVault() {
    if (!isValidAddress(address)) {
      log("Enter a valid BRODelegator vault address (KT1...).");
      return;
    }

    setLoadingVault(true);
    try {
      const { toolkit } = await wallet.ensureWallet();
      const contract: any = await toolkit.wallet.at(address);
      const storage: any = await contract.storage();
      const tally = await readTally(address);
      const myShares = wallet.address ? toBigInt(await storage.shares.get(wallet.address) ?? 0) : 0n;
      const myVote = wallet.address ? readOption(await storage.votes.get(wallet.address)) : null;

      setState({
        delegate: readOption(storage.delegate),
        quorumBps: toBigInt(storage.quorum_bps),
        totalShares: toBigInt(storage.total_shares),
        myShares,
        myVote,
        tally,
      });
      log("Voting vault loaded.");
    } catch (error) {
      log(`Failed to load voting vault: ${getErrorMessage(error)}`);
    } finally {
      setLoadingVault(false);
    }
  }

  async function refresh() {
    await loadVault();
  }

  async function send(entrypoint: "vote" | "withdraw_vote" | "update_delegate", argument?: string) {
    if (!wallet.address) {
      log("Connect a wallet first.");
      return;
    }
    if (!isValidAddress(address)) {
      log("Load a valid BRODelegator vault first.");
      return;
    }

    if (entrypoint === "vote") setVoting(true);
    if (entrypoint === "withdraw_vote") setWithdrawingVote(true);
    if (entrypoint === "update_delegate") setUpdatingDelegate(argument ?? null);

    try {
      const { toolkit } = await wallet.ensureWallet();
      const vault: any = await toolkit.wallet.at(address);
      const operation = argument === undefined
        ? await vault.methodsObject[entrypoint]().send()
        : await vault.methodsObject[entrypoint](argument).send();
      log(`Op hash: ${operation.opHash}`);
      await operation.confirmation();
      log(`${entrypoint} complete.`);
      await refresh();
    } catch (error) {
      log(`${entrypoint} failed: ${getErrorMessage(error)}`);
    } finally {
      if (entrypoint === "vote") setVoting(false);
      if (entrypoint === "withdraw_vote") setWithdrawingVote(false);
      if (entrypoint === "update_delegate") setUpdatingDelegate(null);
    }
  }

  function submitVote() {
    const candidate = baker.trim();
    if (!isBakerAddress(candidate)) {
      log("Enter a valid baker address (tz1, tz2, or tz3).");
      return;
    }
    void send("vote", candidate);
  }

  const currentVotes = state.tally.find((entry) => entry.baker === state.delegate)?.votes ?? 0n;

  return <Page title="Vote for the DEX Baker" subtitle="Use your DEX liquidity shares to vote for a baker and help select the vault's delegate.">
    <NetworkWallet wallet={wallet} />
    <Section title="3. Voting Vault">
      <label>Delegator vault address
        <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="KT1..." />
      </label>
      <p className="hint">The vault must be linked to a DEX and have synchronized LP share balances.</p>
      <div className="row">
        <LoadingButton className="secondary" loading={loadingVault} onClick={() => void loadVault()}>Load Vault</LoadingButton>
      </div>
      <div className="info">
        {`Current baker: ${shortAddress(state.delegate)}\nQuorum: ${(Number(state.quorumBps) / 100).toFixed(2)}% of shares\nTotal LP shares: ${state.totalShares.toString()}`}
      </div>
    </Section>
    <Section title="4. Your Vote">
      <div className="info">
        {`Your LP shares: ${wallet.address ? state.myShares.toString() : "Connect wallet"}\nYour vote: ${state.myVote ? shortAddress(state.myVote) : wallet.address ? "No vote" : "—"}`}
      </div>
      <label>Baker address
        <input value={baker} onChange={(event) => setBaker(event.target.value)} placeholder="tz1..., tz2..., or tz3..." />
      </label>
      <div className="row">
        <LoadingButton loading={voting} disabled={!wallet.address || state.myShares === 0n} onClick={submitVote}>Vote</LoadingButton>
        <LoadingButton className="secondary" loading={withdrawingVote} disabled={!wallet.address || !state.myVote} onClick={() => void send("withdraw_vote")}>Remove Vote</LoadingButton>
      </div>
      <p className="hint">Your voting weight equals your LP shares and is updated automatically when your liquidity changes.</p>
    </Section>
    <Section title="5. Votes per Baker">
      <div className="info">
        {state.tally.length ? "" : "No votes yet."}
      </div>
      {state.tally.length > 0 && <div className="table-wrap">
        <table>
          <thead><tr><th>Baker</th><th>Shares</th><th>Share</th><th>Action</th></tr></thead>
          <tbody>
            {state.tally.map((entry) => {
              const quorumMet = entry.votes * 10000n >= state.totalShares * state.quorumBps;
              const canUpdate = wallet.address && entry.baker !== state.delegate && quorumMet && entry.votes > currentVotes;
              return <tr key={entry.baker}>
                <td>
                  <code title={entry.baker}>{shortAddress(entry.baker)}</code>
                  {entry.baker === state.delegate && <span className="tag ok">delegate</span>}
                  {entry.baker === state.myVote && <span className="tag warn">your vote</span>}
                  {!quorumMet && <span className="tag">below quorum</span>}
                </td>
                <td>{entry.votes.toString()}</td>
                <td>{percentage(entry.votes, state.totalShares)}</td>
                <td>
                  <div className="row">
                    {wallet.address && state.myShares > 0n && entry.baker !== state.myVote &&
                      <LoadingButton className="secondary small" loading={voting} onClick={() => void send("vote", entry.baker)}>Vote</LoadingButton>}
                    {canUpdate &&
                      <LoadingButton className="small" loading={updatingDelegate === entry.baker} onClick={() => void send("update_delegate", entry.baker)}>Make Delegate</LoadingButton>}
                  </div>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>}
      <p className="hint">A baker needs quorum and more votes than the current delegate. Anyone can trigger the delegate update.</p>
    </Section>
    <Status messages={messages} />
  </Page>;
}
