// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BridgeSource
 * @notice Manages token locking (escrow) and unlocking on Ethereum Sepolia.
 * @dev Emits events for the off-chain relayer and enforces replay protection on unlocks.
 */
contract BridgeSource is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Custom Errors ---
    error ZeroAddress();
    error ZeroAmount();
    error SameChainNotAllowed(uint256 chainId);
    error CallerNotRelayer(address caller);
    error MessageAlreadyProcessed(bytes32 messageId);

    // --- State Variables ---
    /// @notice The ERC-20 token supported by this bridge on the source chain.
    IERC20 public immutable token;

    /// @notice The trusted off-chain relayer authorized to execute unlocks.
    address public relayer;

    /// @notice Monotonically increasing counter ensuring every lock action is unique.
    uint256 public nextNonce;

    /// @notice Registry of processed cross-chain message hashes to prevent replay attacks.
    mapping(bytes32 => bool) public processedMessages;

    // --- Events ---
    /// @notice Emitted when a user locks tokens on this chain intended for destination minting.
    event Locked(
        address indexed sender,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        uint256 nonce,
        uint256 destinationChainId,
        bytes32 messageId
    );

    /// @notice Emitted when the relayer unlocks escrowed tokens back to a user.
    event Unlocked(
        bytes32 indexed messageId,
        address indexed recipient,
        uint256 amount
    );

    /// @notice Emitted when the bridge relayer address is updated.
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);

    // --- Modifiers ---
    modifier onlyRelayer() {
        if (msg.sender != relayer) {
            revert CallerNotRelayer(msg.sender);
        }
        _;
    }

    /**
     * @param _token Address of the ERC-20 token being bridged.
     * @param _relayer Address of the trusted off-chain relayer.
     * @param _owner Administrator of the bridge contract.
     */
    constructor(
        address _token,
        address _relayer,
        address _owner
    ) Ownable(_owner) {
        if (_token == address(0) || _relayer == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        token = IERC20(_token);
        relayer = _relayer;
    }

    /**
     * @notice Locks tokens in escrow on Sepolia for bridging to a destination chain.
     * @param recipient Target address on the destination chain.
     * @param amount Quantity of tokens to bridge (in wei).
     * @param destinationChainId The EIP-155 chain ID of the destination network.
     * @return messageId Unique cryptographic identifier of this lock request.
     */
    function lockTokens(
        address recipient,
        uint256 amount,
        uint256 destinationChainId
    ) external whenNotPaused nonReentrant returns (bytes32 messageId) {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (destinationChainId == block.chainid) revert SameChainNotAllowed(destinationChainId);

        uint256 nonce = nextNonce++;

        // Compute a unique deterministic message ID binding all transfer parameters
        messageId = keccak256(
            abi.encodePacked(
                block.chainid,
                destinationChainId,
                address(this),
                nonce,
                msg.sender,
                recipient,
                amount
            )
        );

        // Pull tokens into escrow (requires prior approve() from user)
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Locked(
            msg.sender,
            recipient,
            address(token),
            amount,
            nonce,
            destinationChainId,
            messageId
        );
    }

    /**
     * @notice Unlocks escrowed tokens to a user upon verified burn on the destination chain.
     * @dev Only callable by the trusted relayer.
     * @param messageId Unique cross-chain message digest from the destination chain.
     * @param recipient Address receiving the unlocked tokens on Sepolia.
     * @param amount Quantity of tokens to release.
     */
    function unlockTokens(
        bytes32 messageId,
        address recipient,
        uint256 amount
    ) external onlyRelayer whenNotPaused nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (processedMessages[messageId]) revert MessageAlreadyProcessed(messageId);

        // State change before external interaction (Checks-Effects-Interactions)
        processedMessages[messageId] = true;

        // Release escrowed tokens to the user
        token.safeTransfer(recipient, amount);

        emit Unlocked(messageId, recipient, amount);
    }

    // --- Emergency & Admin Functions ---

    /**
     * @notice Updates the trusted relayer address.
     * @param newRelayer New relayer address.
     */
    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0)) revert ZeroAddress();
        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    /**
     * @notice Pauses bridge locking and unlocking in case of an incident.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Resumes bridge operations.
     */
    function unpause() external onlyOwner {
        _unpause();
    }
}

