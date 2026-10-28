# MiniBridge: Educational Cross-Chain Token Bridge

MiniBridge is an educational, lock-and-mint cross-chain token bridge built between two EVM testnets: **Ethereum Sepolia** (source chain) and **Polygon Amoy** (destination chain).

Inspired by the open-source Smoot bridge architecture, MiniBridge demonstrates the foundational mechanics of cross-chain interoperability: escrow locking, synthetic minting, cross-chain burning, asset unlocking, reorg finality buffers, and cryptographic replay protection.

---

## 1. Architecture & Component Overview

```text
========================================================================================
DIRECTION 1: LOCK & MINT (Sepolia -> Amoy)
========================================================================================

  User                    Sepolia (Source)           Off-Chain Relayer          Amoy (Destination)
   │                             │                           │                          │
   │ 1. approve(bridge, amount)  │                           │                          │
   │────────────────────────────>│                           │                          │
   │ 2. lockTokens(...)          │                           │                          │
   │────────────────────────────>│ (transfers to escrow)     │                          │
   │                             │ emits Locked(..., nonce)  │                          │
   │                             ├──────────────────────────>│                          │
   │                             │                           │ 3. Waits N confirmations │
   │                             │                           │ 4. Computes messageId    │
   │                             │                           │ 5. mintWrapped(...)      │
   │                             │                           │─────────────────────────>│
   │                             │                           │                          │ (checks messageId)
   │                             │                           │                          │ mints wrapped token
   │                             │                           │                          │ to User address
   │                             │                           │                          │
   ▼                             ▼                           ▼                          ▼

========================================================================================
DIRECTION 2: BURN & UNLOCK (Amoy -> Sepolia)
========================================================================================

  User                    Amoy (Destination)         Off-Chain Relayer          Sepolia (Source)
   │                             │                           │                          │
   │ 1. burnTokens(amount, ...)  │                           │                          │
   │────────────────────────────>│ (burns wrapped tokens)    │                          │
   │                             │ emits Burned(..., nonce)  │                          │
   │                             ├──────────────────────────>│                          │
   │                             │                           │ 2. Waits N confirmations │
   │                             │                           │ 3. Computes messageId    │
   │                             │                           │ 4. unlockTokens(...)     │
   │                             │                           │─────────────────────────>│
   │                             │                           │                          │ (checks messageId)
   │                             │                           │                          │ transfers original
   │                             │                           │                          │ token to User
   │                             │                           │                          │
   ▼                             ▼                           ▼                          ▼
```

### Core Components

1. **`contracts/TestToken.sol` (Sepolia):**
   - Standard ERC-20 token representing the original asset ("Bridge Test Token", `BTT`).
   - Includes a self-service faucet capped at 1,000 BTT per call for testing.

2. **`contracts/BridgeSource.sol` (Sepolia):**
   - Escrows original tokens during cross-chain transfers.
   - Emits `Locked` events with incremental `nonce`, user address, token address, amount, and unique `messageId`.
   - Allows the trusted relayer to execute `unlockTokens()` when tokens are burned on the destination chain.

3. **`contracts/WrappedToken.sol` (Amoy):**
   - Synthetic ERC-20 token ("Wrapped Bridge Test Token", `wBTT`) pegged 1:1 with locked `BTT`.
   - `mint()` and `burn()` methods are restricted strictly to the `BridgeDestination` controller.

4. **`contracts/BridgeDestination.sol` (Amoy):**
   - Bridge controller on Polygon Amoy.
   - Mints `wBTT` upon receiving verified `Locked` events from the relayer.
   - Destroys `wBTT` when a user initiates a return trip via `burnTokens()`, emitting a `Burned` event.

5. **`relayer/index.ts` (Off-Chain Daemon):**
   - Listens for `Locked` and `Burned` events on both networks.
   - Waits for configurable block confirmations to guard against chain reorganizations.
   - Persists scanning progress in `relayer-state.json`.
   - Submits counter-transactions with exponential backoff retry logic.

6. **`scripts/cli.ts` (Command-Line Interface):**
   - Interactive command-line client to request faucet tokens, query balances, and initiate locks and burns.

---

## 2. Replay Protection Mechanism

To prevent an adversary from resubmitting an event payload to steal funds or inflate synthetic supply, MiniBridge enforces dual-layer replay protection:

1. **Cryptographically Unique `messageId`:**
   $$\text{messageId} = \text{keccak256}(\text{abi.encodePacked}(\text{srcChainId}, \text{dstChainId}, \text{bridgeAddress}, \text{nonce}, \text{sender}, \text{recipient}, \text{amount}))$$
2. **On-Chain Settlement Registry:**
   Both `BridgeSource` and `BridgeDestination` maintain:
   ```solidity
   mapping(bytes32 => bool) public processedMessages;
   ```
   If a message has already been processed, the transaction reverts immediately:
   ```solidity
   if (processedMessages[messageId]) revert MessageAlreadyProcessed(messageId);
   processedMessages[messageId] = true;
   ```

---

## 3. Getting Started

### Prerequisites
- Node.js LTS (v18 or v20+)
- npm

### Installation
```bash
git clone https://github.com/SarthakKharat07/CrossChain.git
cd CrossChain
npm install
```

### Environment Configuration
Copy `example.env` to `.env`:
```bash
cp example.env .env
```
Fill in your testnet wallet credentials:
```env
SEPOLIA_RPC_URL="https://ethereum-sepolia-rpc.publicnode.com"
AMOY_RPC_URL="https://rpc-amoy.polygon.technology"

# CAUTION: Use a dedicated testnet wallet with NO real funds!
DEPLOYER_PRIVATE_KEY="your_private_key_without_0x"
RELAYER_PRIVATE_KEY="your_private_key_without_0x"
```

---

## 4. Testing & Coverage

Run the automated test suite covering round-trips, replay prevention, unauthorized minting, pausing, and input validation:
```bash
npx hardhat test
```

Generate the test coverage report:
```bash
npx hardhat coverage
```

---

## 5. Live Testnet Deployment & Execution Walkthrough

### Step A: Acquire Free Testnet Gas
1. **Sepolia ETH:** Obtain testnet ETH from [Sepolia PoW Faucet](https://sepolia-faucet.pk910.de/) or [Google Cloud Web3 Faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia).
2. **Polygon Amoy POL:** Obtain testnet POL from [Polygon Faucet](https://faucet.polygon.technology/).

### Step B: Deploy Contracts to Sepolia
```bash
npx hardhat run scripts/deploySepolia.ts --network sepolia
```
*Copy `SEPOLIA_TEST_TOKEN_ADDRESS` and `SEPOLIA_BRIDGE_SOURCE_ADDRESS` into your `.env`.*

### Step C: Deploy Contracts to Polygon Amoy
```bash
npx hardhat run scripts/deployAmoy.ts --network amoy
```
*Copy `AMOY_WRAPPED_TOKEN_ADDRESS` and `AMOY_BRIDGE_DESTINATION_ADDRESS` into your `.env`.*

### Step D: Start the Relayer Daemon
In a dedicated terminal window, run:
```bash
npm run relayer
```
The relayer will connect to both chains and begin listening for events.

### Step E: Execute a Full Cross-Chain Round Trip

1. **Mint Test Tokens on Sepolia:**
   ```bash
   npx hardhat run scripts/cli.ts --network sepolia faucet
   ```
2. **Lock 10 Tokens on Sepolia (Transfer to Amoy):**
   ```bash
   npx hardhat run scripts/cli.ts --network sepolia lock
   ```
   *Watch your relayer terminal detect the `Locked` event, wait for confirmations, and submit `mintWrapped()` on Polygon Amoy!*
3. **Verify Wrapped Balance on Amoy:**
   ```bash
   npx hardhat run scripts/cli.ts --network amoy balances
   ```
4. **Burn 5 Wrapped Tokens on Amoy (Transfer back to Sepolia):**
   ```bash
   npx hardhat run scripts/cli.ts --network amoy burn
   ```
   *Watch your relayer terminal detect the `Burned` event and submit `unlockTokens()` on Ethereum Sepolia!*
5. **Verify Restored Balance on Sepolia:**
   ```bash
   npx hardhat run scripts/cli.ts --network sepolia balances
   ```

---

## 6. Security Assumptions & Known Limitations

1. **Centralized Relayer Trust:**
   - **Limitation:** In this learning design, a single relayer key possesses the authority to call `mintWrapped()` and `unlockTokens()`. If that key is compromised, unauthorized mints can occur.
   - **Production Standard:** Multi-Party Computation (MPC), Threshold Signatures (TSS), or decentralized validator networks (e.g., Chainlink DONs).
2. **RPC Availability & Finality Delays:**
   - Public RPCs may throttle requests. The relayer uses exponential backoff retry logic, but production setups require private dedicated nodes (e.g. Alchemy, Infura, QuickNode) with fallback providers.
3. **1:1 Fixed Token Pair:**
   - This bridge is designed specifically for the `TestToken` / `WrappedToken` pair rather than generic arbitrary asset routing.

---

## 7. Roadmap & Potential Upgrades

- **Liquidity Pool (AMM) Mode:** Support bridging native assets without synthetic wrapped tokens by maintaining rebalanced pools on each chain.
- **Decentralized Multi-Validator Committee:** Replace single-key authority with an on-chain threshold signature verifier (`ecrecover` or Schnorr signature checks requiring $M$-of-$N$ validator signatures).
- **ZK Light-Client Proofs:** Integrate zero-knowledge state proofs (e.g., Succinct / Telepathy) to cryptographically verify source chain consensus on the destination chain without trusting off-chain actors.
- **Dynamic Token Registry:** Enable cross-chain registration for arbitrary ERC-20 tokens via factory contracts.

---

## 8. What to Study Next

To advance from this educational bridge to production-grade interoperability engineering, explore:
1. **EIP-712 Typed Structured Data:** Learn how to sign structured cross-chain messages off-chain and verify them on-chain using `ECDSA.recover`.
2. **Consensus Finality & LMD-GHOST / Casper FFG:** Deepen your understanding of Ethereum's "Safe" vs. "Finalized" block tags to prevent bridge reorg exploits.
3. **Industry Cross-Chain Protocols:** Study the architectures of **Chainlink CCIP**, **Axelar Network**, and **LayerZero v2**.
4. **Merkle Trees & Patricia Trie Proofs:** Study how Ethereum storage proofs work to verify account balances and event emissions trustlessly.

