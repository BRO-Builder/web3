# BRO Builder Web3

Tezos smart contracts for BRO Builder, and the **Web3 Portal**: a web app to deploy and use them from a browser wallet.

## What's inside

The contracts form two systems that share the BRO token.

### Token, DEX and Delegator

Trade BRO, provide liquidity, and earn baker rewards on the pool's XTZ.

| Contract | What it does |
|---|---|
| **BROToken** | The BRO token, an FA2 fungible token. |
| **BRODex** | A constant-product (x·y=k) exchange between BRO and XTZ. Liquidity providers receive pool shares and earn the swap fee. |
| **BRODelegator** | A vault that holds all of the DEX's XTZ and delegates it to a baker. Liquidity providers vote for the baker with their pool shares, and baker rewards are added to the pool. |

### Projects, Funding and Market Assistant

Contractors request funding for building projects, investors fund them and earn interest, and amounts stay fixed in USD while the token price moves.

| Contract | What it does |
|---|---|
| **BROFunding** | Lists projects with a USD budget, interest rate, term and milestones. Investors deposit BRO until the budget is reached. If funding fails or a project is cancelled, investors get a refund. |
| **BROProjects** | Runs a funded project: holds the BRO in escrow, pays the contractor per approved milestone, collects repayment with interest, and pays investors their share when the project settles. |
| **BROMarketAssistant** | Publishes the BRO/USD price, and keeps a BRO reserve that covers the difference when the BRO price changes between funding, milestone payouts and repayment. |

> **Warning:** the Projects, Funding and Market Assistant contracts have not been audited yet. Do not use them with real funds until they have been independently audited.

How a project works:

1. A contractor submits a project with a USD budget, an interest rate, a repayment term and milestones.
2. Investors deposit BRO. Each deposit counts toward the budget at the current BRO/USD price.
3. Once the budget is reached, the project starts. Each milestone is paid out after it's approved, in BRO worth the milestone's USD amount, minus a fee if the milestone is late.
4. When every milestone is paid, the contractor repays the budget plus interest in USD terms.
5. The project settles on full repayment or on default. Investors then claim their deposit plus interest in BRO, as far as the repaid funds and the reserve allow.

> **Privacy:** everything stored on the blockchain is public and permanent. Project listings, including the site address and the owner's name, phone and email, can be read by anyone and cannot be deleted.

## Web3 Portal

The portal connects to a Tezos wallet (any Beacon-compatible wallet, such as Temple or Kukai) and works on ShadowNet, Ghostnet and Mainnet.

| Tool | Use it to |
|---|---|
| **Deployment pages** | Deploy each contract with your own settings. |
| **DEX Pool Setup** | Link a new DEX to its vault and token, and add its first liquidity. |
| **BRO Projects Setup** | Link the projects contracts, fund the reserve, set the first price, and manage admin settings. |
| **Exchange** | Swap XTZ and a token, with live quotes and slippage protection. |
| **Liquidity** | Add liquidity to earn swap fees, or withdraw your share. |
| **Baker Voting** | Vote for the baker the DEX's XTZ is delegated to. |
| **BRO Projects** | Submit projects, invest, approve and claim milestones, repay, and claim payouts. |

## Development

Requirements: Node.js and npm for the portal, Python 3 with [SmartPy](https://smartpy.io) 0.24 for the contracts.

```sh
npm install
npm run dev      # start the portal locally
npm run build    # type-check and build into dist/
```

Each contract file includes a test scenario. Running it compiles the contract and runs the tests, with output in `build/<ContractName>/`:

```sh
python -m contracts.brodex     # likewise brotoken, brodelegator, bromarket, brofunding, broprojects
```

### Project structure

```
contracts/   SmartPy contracts and their test scenarios
src/         Web3 Portal (React + Vite + Taquito)
docs/        Contract design notes
```

## License

Unlicensed: no license is granted to use, copy or modify this code
