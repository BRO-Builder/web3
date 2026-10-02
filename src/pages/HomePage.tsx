import { Link } from "react-router-dom";

const tools = [
  ["Fungible-Token (FA2) Deployment", "Connect a wallet, configure your token details, and originate the compiled FT contract on Tezos.", "/deployment-ft", "Open Deployment Page"],
  ["Token <-> XTZ DEX Deployment", "Pair an FA2 token with XTZ, set the swap fee, and originate the constant-product DEX contract on Tezos.", "/deployment-dex", "Open Deployment Page"],
  ["DEX Pool Setup", "Authorize the DEX as an operator on your FA2 token and seed the pool with its first liquidity.", "/deployment-dex-setup", "Open Setup Page"],
  ["Token <-> XTZ Exchange", "Swap XTZ and an FA2 token against a deployed DEX pool, with live quotes and slippage protection.", "/exchange-dex", "Open Exchange"],
  ["DEX Liquidity", "Add liquidity to a DEX pool to earn swap fees, or redeem your pool shares for XTZ and tokens.", "/liquidity-dex", "Manage Liquidity"],
];

export function HomePage() {
  return (
    <main className="wide">
      <h1>Web3 Tools</h1>
      <p className="sub">Internal / partner tools for on-chain deployments.</p>

      <h3 className="section-title">Deployment and Trading</h3>
      <div className="card-grid">
        { tools.map(([title, copy, to, action]) => (
          <article className="card" key={to}>
            <h2>{title}</h2>
            <p>{copy}</p>
            <Link className="button" to={to}>{action}</Link>
          </article>
        )) }
      </div>
    </main>
  );
}