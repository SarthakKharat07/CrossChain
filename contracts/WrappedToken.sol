// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title WrappedToken
 * @notice Synthetic representation of the bridged token on Polygon Amoy.
 * @dev Minting and burning are strictly restricted to the authorized bridge controller contract.
 */
contract WrappedToken is ERC20, Ownable, Pausable {
    // --- Custom Errors ---
    error ZeroAddress();
    error CallerNotController(address caller);

    // --- State Variables ---
    /// @notice The only contract address permitted to call mint() and burn().
    address public bridgeController;

    // --- Events ---
    /// @notice Emitted when the bridge controller address is modified.
    event BridgeControllerUpdated(
        address indexed previousController,
        address indexed newController
    );

    // --- Modifiers ---
    modifier onlyBridgeController() {
        if (msg.sender != bridgeController) {
            revert CallerNotController(msg.sender);
        }
        _;
    }

    /**
     * @param initialOwner Administrator address capable of assigning the bridge controller.
     */
    constructor(address initialOwner)
        ERC20("Wrapped Bridge Test Token", "wBTT")
        Ownable(initialOwner)
    {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    /**
     * @notice Designates the destination bridge contract as the authorized controller.
     * @param _bridgeController Address of the BridgeDestination contract.
     */
    function setBridgeController(address _bridgeController) external onlyOwner {
        if (_bridgeController == address(0)) revert ZeroAddress();
        emit BridgeControllerUpdated(bridgeController, _bridgeController);
        bridgeController = _bridgeController;
    }

    /**
     * @notice Mints wrapped tokens to a user upon verified cross-chain deposit.
     * @dev Only callable by the bridge controller when not paused.
     * @param to Recipient address on Amoy.
     * @param amount Quantity of tokens in wei.
     */
    function mint(address to, uint256 amount)
        external
        onlyBridgeController
        whenNotPaused
    {
        _mint(to, amount);
    }

    /**
     * @notice Burns wrapped tokens when a user initiates a cross-chain return to Sepolia.
     * @dev Only callable by the bridge controller when not paused.
     * @param from Address whose wrapped tokens are being destroyed.
     * @param amount Quantity of tokens in wei.
     */
    function burn(address from, uint256 amount)
        external
        onlyBridgeController
        whenNotPaused
    {
        _burn(from, amount);
    }

    /**
     * @notice Pauses token minting and burning in emergencies.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Resumes token minting and burning.
     */
    function unpause() external onlyOwner {
        _unpause();
    }
}

