Educational project for the course Introduction to Finance. Not a real product, service or investment offer. Do not use with real funds.

### Group: SE-2539
### Team: Aktanbi, Yernar, Galymzhan

# QorLend prototype

Prototype of the hypothetical project QorLend (Introduction to Finance, Final Project, Team [NN], Astana IT University).
It is a small overcollateralised lending pool written in Solidity. It runs only on the local Hardhat network with
test accounts. Nothing here is deployed to a public network, and no real cryptocurrency is used.

Demo video (up to 3 minutes): [paste the link here]
Testnet contract address: none (local network only)

## What it does

The core use case (see `docs/sequence-diagram.mmd`):

1. A supplier adds liquidity (fake stable unit `mUSD`).
2. A borrower deposits collateral (fake token `mCOL`) and borrows up to 60% of its value. The model assumes 55% on average.
3. Interest accrues at 16% per year (simple interest).
4. If the collateral price falls so that the health factor drops below 1, anyone can liquidate: the liquidator repays the debt
   and receives collateral plus a 5% bonus. If collateral does not cover the debt, the rest is recorded as bad debt.

Parameters follow the Endterm model: max LTV 60%, liquidation threshold 75%, borrower rate 16%.
Health factor = collateral value x 0.75 / debt.

Roles: `DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE`. The admin can only pause and unpause. There is no function that lets
the admin move user funds or change the oracle or the risk parameters.

Contracts in `contracts/`:
- `QorLendPool.sol`: the pool (OpenZeppelin AccessControl, ReentrancyGuard, Pausable, SafeERC20)
- `MockToken.sol`, `MockOracle.sol`: fake token and fake price feed for tests
- `ReentrantToken.sol`: malicious token used only in a test of the reentrancy guard

Simplifications: one collateral token, one stable unit, simple interest, no supplier interest accounting, no tokenomics.

## How to run (local network)

```
npm install
npx hardhat test              # runs the 11 unit tests
npx hardhat run scripts/demo.js   # prints the main use case step by step
```

Requires Node.js 18 or newer. The compiler comes from the `solc` npm package, so the first run needs internet only for `npm install`.
Never put real keys in this repository. Keys belong in a `.env` file, which is listed in `.gitignore`.

## Credits and licence

Uses OpenZeppelin Contracts 5.1.0 (MIT licence). This project is also MIT licensed.

## Team

Team members: Aktanbi Kusman, Yernar Kuanyshbek, Galymzhan Amantay.

Team members is responsible for part: 
* Yernar QorLendPool.sol;
* Galymzhan tests and mock contracts;
* Aktanbi demo script, configuration, README and video.
