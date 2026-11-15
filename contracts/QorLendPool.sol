// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IPriceOracle {
    /// @return price of one collateral token in stable units (1e18 scale), and the update time
    function latestPrice() external view returns (uint256 price, uint256 updatedAt);
}

/// @title QorLendPool
/// @notice Educational prototype of an overcollateralised lending pool (hypothetical project QorLend).
/// @dev NOT a real product. Local test network only. Simplifications: one collateral token,
///      one stable unit, simple (non-compounding) interest, no supplier interest accounting.
///      Parameters follow the Endterm model: max LTV 60%, liquidation threshold 75%, 16% borrower rate.
contract QorLendPool is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ---- Roles: the admin can only pause. Nobody can move user funds. ----
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ---- Risk parameters (basis points, 10,000 = 100%) ----
    uint256 public constant MAX_LTV_BPS = 6000;          // max loan-to-value when borrowing
    uint256 public constant LIQ_THRESHOLD_BPS = 7500;    // liquidation threshold
    uint256 public constant LIQ_BONUS_BPS = 500;         // 5% bonus for the liquidator
    uint256 public constant BORROW_RATE_BPS = 1600;      // 16% per year, simple interest
    uint256 public constant MAX_PRICE_AGE = 1 hours;     // stale-price protection
    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;
    uint256 private constant ONE = 1e18;

    IERC20 public immutable collateralToken;
    IERC20 public immutable stableToken;
    IPriceOracle public immutable oracle;

    struct Position {
        uint256 collateral; // collateral tokens
        uint256 debt;       // stable units owed, including accrued interest
        uint256 lastAccrual;
    }

    mapping(address => Position) public positions;
    uint256 public totalBadDebt; // debt that collateral could not cover after liquidation

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event LiquiditySupplied(address indexed supplier, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(address indexed borrower, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized);
    event BadDebtRecorded(address indexed borrower, uint256 amount);

    constructor(address collateral_, address stable_, address oracle_, address admin) {
        require(collateral_ != address(0) && stable_ != address(0) && oracle_ != address(0) && admin != address(0), "zero address");
        collateralToken = IERC20(collateral_);
        stableToken = IERC20(stable_);
        oracle = IPriceOracle(oracle_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ------------------------------------------------------------------ admin
    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ------------------------------------------------------------------ views
    /// @notice Current debt including interest accrued since the last update.
    function currentDebt(address user) public view returns (uint256) {
        Position memory p = positions[user];
        if (p.debt == 0) return 0;
        return p.debt + (p.debt * BORROW_RATE_BPS * (block.timestamp - p.lastAccrual)) / (BPS * YEAR);
    }

    /// @notice Health factor = collateral value x liquidation threshold / debt (1e18 scale). Below 1e18 = liquidatable.
    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = currentDebt(user);
        if (debt == 0) return type(uint256).max;
        return (_collateralValue(positions[user].collateral) * LIQ_THRESHOLD_BPS * ONE) / (BPS * debt);
    }

    // ------------------------------------------------------------ user actions
    function supplyLiquidity(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "amount is zero");
        stableToken.safeTransferFrom(msg.sender, address(this), amount);
        emit LiquiditySupplied(msg.sender, amount);
    }

    function depositCollateral(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "amount is zero");
        Position storage p = positions[msg.sender];
        p.collateral += amount;                                   // effects first
        collateralToken.safeTransferFrom(msg.sender, address(this), amount); // interaction last
        emit CollateralDeposited(msg.sender, amount);
    }

    function borrow(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "amount is zero");
        _accrue(msg.sender);
        Position storage p = positions[msg.sender];
        uint256 newDebt = p.debt + amount;
        require(newDebt * BPS <= _collateralValue(p.collateral) * MAX_LTV_BPS, "exceeds max LTV");
        require(stableToken.balanceOf(address(this)) >= amount, "not enough liquidity");
        p.debt = newDebt;
        stableToken.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "amount is zero");
        _accrue(msg.sender);
        Position storage p = positions[msg.sender];
        uint256 pay = amount > p.debt ? p.debt : amount;
        require(pay > 0, "no debt");
        p.debt -= pay;
        stableToken.safeTransferFrom(msg.sender, address(this), pay);
        emit Repaid(msg.sender, pay);
    }

    function withdrawCollateral(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "amount is zero");
        _accrue(msg.sender);
        Position storage p = positions[msg.sender];
        require(p.collateral >= amount, "not enough collateral");
        p.collateral -= amount;
        // the position must stay inside the max LTV after the withdrawal
        require(p.debt * BPS <= _collateralValue(p.collateral) * MAX_LTV_BPS, "would exceed max LTV");
        collateralToken.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    /// @notice Anyone can repay part of an unsafe loan and receive collateral plus a bonus.
    function liquidate(address borrower, uint256 repayAmount) external nonReentrant whenNotPaused {
        require(repayAmount > 0, "amount is zero");
        _accrue(borrower);
        Position storage p = positions[borrower];
        require(p.debt > 0, "no debt");
        require(healthFactor(borrower) < ONE, "position is healthy");

        uint256 repay_ = repayAmount > p.debt ? p.debt : repayAmount;
        uint256 price = _price();
        // collateral worth (repaid debt + bonus), converted at the oracle price
        uint256 seize = (repay_ * (BPS + LIQ_BONUS_BPS) * ONE) / (BPS * price);
        if (seize > p.collateral) {
            // not enough collateral: take all of it and charge the liquidator only for its value
            seize = p.collateral;
            repay_ = (seize * price * BPS) / ((BPS + LIQ_BONUS_BPS) * ONE);
        }

        p.debt -= repay_;
        p.collateral -= seize;

        // if the collateral is gone but debt remains, record it as bad debt
        if (p.collateral == 0 && p.debt > 0) {
            totalBadDebt += p.debt;
            emit BadDebtRecorded(borrower, p.debt);
            p.debt = 0;
        }

        stableToken.safeTransferFrom(msg.sender, address(this), repay_);
        collateralToken.safeTransfer(msg.sender, seize);
        emit Liquidated(borrower, msg.sender, repay_, seize);
    }

    // ---------------------------------------------------------------- internal
    function _accrue(address user) internal {
        Position storage p = positions[user];
        p.debt = currentDebt(user);
        p.lastAccrual = block.timestamp;
    }

    function _price() internal view returns (uint256) {
        (uint256 price, uint256 updatedAt) = oracle.latestPrice();
        require(price > 0, "invalid price");
        require(block.timestamp - updatedAt <= MAX_PRICE_AGE, "stale price");
        return price;
    }

    function _collateralValue(uint256 collateralAmount) internal view returns (uint256) {
        return (collateralAmount * _price()) / ONE;
    }
}
