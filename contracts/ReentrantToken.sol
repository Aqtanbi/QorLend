// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IDeposit {
    function depositCollateral(uint256 amount) external;
}

/// @title ReentrantToken
/// @notice TEST ONLY. A malicious token that tries to call the pool again while the pool is
///         moving tokens. Used to show that the reentrancy guard works. Never deploy for real.
contract ReentrantToken is ERC20 {
    address public target;

    constructor() ERC20("Malicious Test Token", "mBAD") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setTarget(address target_) external { target = target_; }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (target != address(0)) {
            IDeposit(target).depositCollateral(1); // re-enter the pool in the middle of a transfer
        }
        return super.transferFrom(from, to, value);
    }
}
