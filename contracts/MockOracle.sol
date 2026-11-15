// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockOracle
/// @notice TEST ONLY. Fake price feed: price of one collateral token in stable units (1e18 scale).
///         Anyone can change the price, so tests can simulate a market crash. Never deploy for real.
contract MockOracle {
    uint256 private _price;
    uint256 private _updatedAt;

    event PriceUpdated(uint256 price, uint256 updatedAt);

    constructor(uint256 initialPrice) {
        setPrice(initialPrice);
    }

    /// @notice Sets a new price and marks it as fresh (updated now).
    function setPrice(uint256 newPrice) public {
        _price = newPrice;
        _updatedAt = block.timestamp;
        emit PriceUpdated(newPrice, block.timestamp);
    }

    /// @notice Same interface as IPriceOracle in QorLendPool.
    function latestPrice() external view returns (uint256 price, uint256 updatedAt) {
        return (_price, _updatedAt);
    }
}
