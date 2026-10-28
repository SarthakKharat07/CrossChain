// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TestToken
 * @notice Standard ERC-20 token representing the original asset on Ethereum Sepolia.
 * @dev Includes an open faucet function for educational testnet experiments.
 */
contract TestToken is ERC20, Ownable {
    /// @dev Thrown when a mint request exceeds the per-call faucet limit.
    error FaucetLimitExceeded(uint256 requested, uint256 maxAllowed);

    /// @notice Maximum tokens that can be minted per faucet call (1,000 tokens).
    uint256 public constant FAUCET_LIMIT = 1000 * 1e18;

    /**
     * @param initialOwner Address of the contract administrator.
     */
    constructor(address initialOwner)
        ERC20("Bridge Test Token", "BTT")
        Ownable(initialOwner)
    {
        // Mint an initial supply of 10,000 BTT to the deployer for testing
        _mint(initialOwner, 10_000 * 1e18);
    }

    /**
     * @notice Allows anyone on testnet to request free test tokens for bridging.
     * @param amount The quantity of tokens (in wei) requested.
     */
    function faucet(uint256 amount) external {
        if (amount > FAUCET_LIMIT) {
            revert FaucetLimitExceeded(amount, FAUCET_LIMIT);
        }
        _mint(msg.sender, amount);
    }

    /**
     * @notice Allows the owner to mint arbitrary amounts if required.
     * @param to Recipient address.
     * @param amount Token quantity in wei.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

