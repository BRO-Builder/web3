import { Link } from "react-router-dom";

const tools = [
  ["Fungible-Token (FA2) Deployment", "Connect a wallet, configure your token details, and originate the compiled FT contract on Tezos.", "/deployment-ft", "Open Deployment Page", "deployment"],
  ["BRODelegator Vault Deployment", "Originate the XTZ vault that tracks LP votes, delegates to a baker, and holds the DEX's funds.", "/deployment-delegator", "Open Deployment Page", "deployment"],
  ["Token <-> XTZ DEX Deployment", "Pair an FA2 token with XTZ, set the swap fee, and originate the constant-product DEX contract on Tezos.", "/deployment-dex", "Open Deployment Page", "deployment"],
  ["DEX Pool Setup", "After deploying a DEX, authorize it as an operator on your FA2 token and seed the pool with its first liquidity.", "/deployment-dex-setup", "Open Setup Page", "deployment"],
  ["Token <-> XTZ Exchange", "Swap XTZ and an FA2 token against a deployed DEX pool, with live quotes and slippage protection.", "/exchange-dex", "Open Exchange", "trading"],
  ["DEX Liquidity", "Add liquidity to a DEX pool to earn swap fees, or redeem your pool shares for XTZ and tokens.", "/liquidity-dex", "Manage Liquidity", "trading"],
];

export function HomePage() {
  return (
    <main className="wide">
      <h1>Web3 Tools</h1>
      <p className="sub">Internal / partner tools for on-chain deployments.</p>

      {(["deployment", "trading"] as const).map((category) => <section key={category}>
        <h3 className="section-title">{category === "deployment" ? "Deployment" : "Trading"}</h3>
        <div className="card-grid">
          {tools.filter((tool) => tool[4] === category).map(([title, copy, to, action]) => (
            <article className="card" key={to}>
              <h2>{title}</h2>
              <p>{copy}</p>
              <Link className="button" to={to}>{action}</Link>
            </article>
          ))}
        </div>
      </section>)}
    </main>
  );
}