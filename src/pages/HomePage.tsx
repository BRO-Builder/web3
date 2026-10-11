import { Link } from "react-router-dom";

const tools = [
  ["Fungible-Token (FA2) Deployment", "Connect a wallet, configure your token details, and originate the compiled FT contract on Tezos.", "/deployment-ft", "Open Deployment Page", "deployment"],
  ["BRODelegator Vault Deployment", "Originate the XTZ vault that tracks LP votes, delegates to a baker, and holds the DEX's funds.", "/deployment-delegator", "Open Deployment Page", "deployment"],
  ["Token <-> XTZ DEX Deployment", "Pair an FA2 token with XTZ, set the swap fee, and originate the constant-product DEX contract on Tezos.", "/deployment-dex", "Open Deployment Page", "deployment"],
  ["DEX Pool Setup", "After deploying a DEX, authorize it as an operator on your FA2 token and seed the pool with its first liquidity.", "/deployment-dex-setup", "Open Setup Page", "deployment"],
  ["BROMarketAssistant Deployment", "Originate the BRO/USD price feed and BRO reserve that backs project payouts and settlements.", "/deployment-market", "Open Deployment Page", "deployment"],
  ["BROFunding Deployment", "Originate the contract that lists projects and collects investor BRO until each project is fully funded.", "/deployment-funding", "Open Deployment Page", "deployment"],
  ["BROProjects Deployment", "Originate the contract that escrows funded BRO, pays milestones, and settles repayments.", "/deployment-projects", "Open Deployment Page", "deployment"],
  ["BRO Projects Setup", "After deploying, link BROFunding, BROProjects and the market, fund and manage the reserve, push the first price, and manage admin settings.", "/deployment-projects-setup", "Open Setup Page", "deployment"],
  ["DEX Baker Voting", "Vote with your DEX liquidity shares for a baker and trigger eligible delegate changes for the vault.", "/vote", "Open Voting", "voting"],
  ["Token <-> XTZ Exchange", "Swap XTZ and an FA2 token against a deployed DEX pool, with live quotes and slippage protection.", "/exchange-dex", "Open Exchange", "trading"],
  ["DEX Liquidity", "Add liquidity to a DEX pool to earn swap fees, or redeem your pool shares for XTZ and tokens.", "/liquidity-dex", "Manage Liquidity", "trading"],
  ["BRO Projects", "Submit projects, invest BRO, approve and claim milestones, repay, and claim settlement payouts.", "/projects", "Open Projects", "projects"],
];

export function HomePage() {
  return (
    <main className="wide">
      <h1>Web3 Tools</h1>
      <p className="sub">Internal / partner tools for on-chain deployments.</p>

      {(["deployment", "trading", "projects", "voting"] as const).map((category) => <section key={category}>
        <h3 className="section-title">{category[0].toUpperCase() + category.slice(1)}</h3>
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