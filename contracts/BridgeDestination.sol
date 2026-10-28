// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WrappedToken} from "./WrappedToken.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BridgeDestination
 * @notice Controller for minting and burning wrapped tokens on Polygon Amoy.
 * @dev Enforces replay protection on inbound mints and emits Burned events for the return trip to Sepolia.
 */
contract BridgeDestination is Ownable, Pausable, ReentrancyGuard {
    // --- Custom Errors ---
    error ZeroAddress();
    error ZeroAmount();
    error CallerNotRelayer(address caller);
    error MessageAlreadyProcessed(bytes32 messageId);
    error SameChainNotAllowed(uint256 chainId);

    // --- State Variables ---
    /// @notice The synthetic wrapped token controlled by this bridge.
    WrappedToken public immutable wrappedToken;

    /// @notice The trusted off-chain relayer authorized to execute mints.
    address public relayer;

    /// @notice Monotonically increasing counter guaranteeing unique burn requests.
    uint256 public nextNonce;

    /// @notice Registry of processed cross-chain message hashes to prevent replay attacks.
    mapping(bytes32 => bool) public processedMessages;

    // --- Events ---
    /// @notice Emitted when the relayer mints wrapped tokens after a verified lock on Sepolia.
    event Minted(
        bytes32 indexed messageId,
        address indexed recipient,
        uint256 amount
    );

    /// @notice Emitted when a user burns wrapped tokens to initiate an unlock on Sepolia.
    event Burned(
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 nonce,
        uint256 destinationChainId,
        bytes32 messageId
    );

    /// @notice Emitted when the relayer address is updated.
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);

    // --- Modifiers ---
    modifier onlyRelayer() {
        if (msg.sender != relayer) {
            revert CallerNotRelayer(msg.sender);
        }
        _;
    }

    /**
     * @param _wrappedToken Address of the deployed WrappedToken contract on Amoy.
     * @param _relayer Address of the trusted off-chain relayer.
     * @param _owner Administrator of the destination bridge contract.
     */
    constructor(
        address _wrappedToken,
        address _relayer,
        address _owner
    ) Ownable(_owner) {
        if (_wrappedToken == address(0) || _relayer == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        wrappedToken = WrappedToken(_wrappedToken);
        relayer = _relayer;
    }

    /**
     * @notice Mints wrapped tokens to a user upon verified deposit from Sepolia.
     * @dev Only callable by the trusted relayer.
     * @param messageId Unique cryptographic identifier from the source lock event.
     * @param recipient Target address on Amoy receiving the tokens.
     * @param amount Token quantity in wei.
     */
    function mintWrapped(
        bytes32 messageId,
        address recipient,
        uint256 amount
    ) external onlyRelayer whenNotPaused nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (processedMessages[messageId]) revert MessageAlreadyProcessed(messageId);

        // State update before minting (Checks-Effects-Interactions)
        processedMessages[messageId] = true;

        // Execute synthetic mint
        wrappedToken.mint(recipient, amount);

        emit Minted(messageId, recipient, amount);
    }

    /**
     * @notice Burns wrapped tokens on Amoy to unlock the original tokens on Sepolia.
     * @param amount Quantity of wrapped tokens to destroy.
     * @param recipient Address on the destination chain (Sepolia) who will receive original tokens.
     * @param destinationChainId The EIP-155 chain ID of the target network (e.g. 11155111).
     * @return messageId Unique cryptographic identifier of this burn action.
     */
    function burnTokens(
        uint256 amount,
        address recipient,
        uint256 destinationChainId
    ) external whenNotPaused nonReentrant returns (bytes32 messageId) {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (destinationChainId == block.chainid) revert SameChainNotAllowed(destinationChainId);

        uint256 nonce = nextNonce++;

        // Compute unique deterministic message ID for the return trip
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

        // Destroy wrapped tokens from the sender's balance
        wrappedToken.burn(msg.sender, amount);

        emit Burned(
            msg.sender,
            recipient,
            amount,
            nonce,
            destinationChainId,
            messageId
        );
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
     * @notice Pauses bridge minting and burning in emergencies.
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

