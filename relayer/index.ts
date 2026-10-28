import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

// =============================================================================
// RELAYER TRUST ASSUMPTION & PRODUCTION COMPARISON:
// -----------------------------------------------------------------------------
// In this educational setup, this service acts as a SINGLE TRUSTED RELAYER.
// The bridge smart contracts (BridgeSource and BridgeDestination) verify that
// incoming mint/unlock calls originate from this relayer's address.
//
// RISK: If this single relayer is compromised, goes offline, or behaves
// maliciously, it creates a single point of failure and censorship risk.
//
// PRODUCTION MITIGATIONS:
// 1. Threshold Signature Schemes (TSS) / Multi-Party Computation (MPC):
//    A decentralized committee of N independent nodes validates events.
//    Only when M-of-N nodes sign an aggregate cryptographic signature does
//    the destination contract execute the mint/unlock.
// 2. Optimistic Verification (e.g. Nomad / Hyperlane):
//    Transfers are posted with a challenge window (fraud proof window). Watchers
//    can veto malicious updates before funds are released.
// 3. Zero-Knowledge / Light-Client Verification (e.g. Telepathy, Succinct):
//    Header synchronization and Merkle state inclusion proofs verify that
//    the lock event legitimately occurred directly on the source blockchain.
// =============================================================================

interface RelayerState {
  lastProcessedBlockSepolia: number;
  lastProcessedBlockAmoy: number;
  processedTxHashes: Record<string, boolean>;
}

const STATE_FILE_PATH = path.resolve(__dirname, "../relayer-state.json");

// Minimal ABI definitions containing only the functions and events needed
const BRIDGE_SOURCE_ABI = [
  "event Locked(address indexed sender, address indexed recipient, address indexed token, uint256 amount, uint256 nonce, uint256 destinationChainId, bytes32 messageId)",
  "function unlockTokens(bytes32 messageId, address recipient, uint256 amount) external",
  "function processedMessages(bytes32 messageId) external view returns (bool)"
];

const BRIDGE_DESTINATION_ABI = [
  "event Burned(address indexed sender, address indexed recipient, uint256 amount, uint256 nonce, uint256 destinationChainId, bytes32 messageId)",
  "function mintWrapped(bytes32 messageId, address recipient, uint256 amount) external",
  "function processedMessages(bytes32 messageId) external view returns (bool)"
];

// Structured Logger
function log(level: "INFO" | "SUCCESS" | "WARN" | "ERROR", message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}]`;
  if (data) {
    console.log(`${prefix} ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// Persistent State Management
function loadState(): RelayerState {
  if (fs.existsSync(STATE_FILE_PATH)) {
    try {
      const raw = fs.readFileSync(STATE_FILE_PATH, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      log("WARN", "Could not parse state file; starting with default state");
    }
  }
  return {
    lastProcessedBlockSepolia: 0,
    lastProcessedBlockAmoy: 0,
    processedTxHashes: {}
  };
}

function saveState(state: RelayerState): void {
  fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), "utf8");
}

// Exponential Backoff Retry Utility
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 2000): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      if (attempt >= maxRetries) {
        throw err;
      }
      log("WARN", `RPC call failed (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms... Error: ${err.message || err}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2; // exponential backoff
    }
  }
}

async function main() {
  log("INFO", "Initializing MiniBridge Relayer Service...");

  const sepoliaRpc = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const amoyRpc = process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology";
  const privateKey = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;

  const bridgeSourceAddress = process.env.SEPOLIA_BRIDGE_SOURCE_ADDRESS;
  const bridgeDestinationAddress = process.env.AMOY_BRIDGE_DESTINATION_ADDRESS;

  if (!privateKey) {
    log("ERROR", "No private key provided in .env (RELAYER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY)");
    process.exit(1);
  }

  if (!bridgeSourceAddress || !bridgeDestinationAddress) {
    log("WARN", "Bridge addresses are not fully set in .env. Waiting for deployment addresses...");
  }

  const sepoliaProvider = new ethers.JsonRpcProvider(sepoliaRpc);
  const amoyProvider = new ethers.JsonRpcProvider(amoyRpc);

  const formattedKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const sepoliaWallet = new ethers.Wallet(formattedKey, sepoliaProvider);
  const amoyWallet = new ethers.Wallet(formattedKey, amoyProvider);

  log("INFO", `Relayer Address: ${sepoliaWallet.address}`);
  log("INFO", `Sepolia RPC: ${sepoliaRpc}`);
  log("INFO", `Amoy RPC: ${amoyRpc}`);

  const requiredConfirmationsSepolia = parseInt(process.env.CONFIRMATIONS_SEPOLIA || "2", 10);
  const requiredConfirmationsAmoy = parseInt(process.env.CONFIRMATIONS_AMOY || "5", 10);
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);

  const state = loadState();

  // If initial block is 0, initialize to latest block minus 10 to avoid scanning from genesis
  if (state.lastProcessedBlockSepolia === 0) {
    state.lastProcessedBlockSepolia = Math.max(0, (await sepoliaProvider.getBlockNumber()) - 10);
  }
  if (state.lastProcessedBlockAmoy === 0) {
    state.lastProcessedBlockAmoy = Math.max(0, (await amoyProvider.getBlockNumber()) - 10);
  }
  saveState(state);

  log("INFO", `Starting scan from Sepolia block ${state.lastProcessedBlockSepolia} and Amoy block ${state.lastProcessedBlockAmoy}`);

  // Main polling loop
  while (true) {
    try {
      if (process.env.SEPOLIA_BRIDGE_SOURCE_ADDRESS && process.env.AMOY_BRIDGE_DESTINATION_ADDRESS) {
        const bridgeSource = new ethers.Contract(
          process.env.SEPOLIA_BRIDGE_SOURCE_ADDRESS,
          BRIDGE_SOURCE_ABI,
          sepoliaWallet
        );
        const bridgeDestination = new ethers.Contract(
          process.env.AMOY_BRIDGE_DESTINATION_ADDRESS,
          BRIDGE_DESTINATION_ABI,
          amoyWallet
        );

        // ---------------------------------------------------------------------
        // SCAN DIRECTION 1: Sepolia (Locked) -> Amoy (Mint)
        // ---------------------------------------------------------------------
        const currentSepoliaBlock = await withRetry(() => sepoliaProvider.getBlockNumber());
        const safeSepoliaBlock = currentSepoliaBlock - requiredConfirmationsSepolia;

        if (safeSepoliaBlock > state.lastProcessedBlockSepolia) {
          const fromBlock = state.lastProcessedBlockSepolia + 1;
          const toBlock = Math.min(safeSepoliaBlock, fromBlock + 500); // chunk queries

          const filter = bridgeSource.filters.Locked();
          const events = await withRetry(() => bridgeSource.queryFilter(filter, fromBlock, toBlock));

          for (const ev of events) {
            const eventLog = ev as ethers.EventLog;
            const txHash = eventLog.transactionHash;
            if (state.processedTxHashes[txHash]) continue;

            const { recipient, amount, messageId, nonce } = eventLog.args;
            log("INFO", `[Sepolia -> Amoy] Detected Locked event in tx ${txHash}: Nonce ${nonce}, Amount: ${ethers.formatEther(amount)} tokens`);

            const isAlreadyProcessed = await withRetry(() => bridgeDestination.processedMessages(messageId));
            if (!isAlreadyProcessed) {
              log("INFO", `[Sepolia -> Amoy] Submitting mintWrapped() on Amoy for messageId: ${messageId}`);
              const tx = await withRetry(() => bridgeDestination.mintWrapped(messageId, recipient, amount));
              log("INFO", `[Sepolia -> Amoy] Mint tx submitted: ${tx.hash}. Awaiting confirmation...`);
              await tx.wait();
              log("SUCCESS", `[Sepolia -> Amoy] Successfully minted on Amoy! Tx: ${tx.hash}`);
            } else {
              log("WARN", `[Sepolia -> Amoy] Message ${messageId} was already processed on Amoy. Skipping.`);
            }

            state.processedTxHashes[txHash] = true;
            saveState(state);
          }

          state.lastProcessedBlockSepolia = toBlock;
          saveState(state);
        }

        // ---------------------------------------------------------------------
        // SCAN DIRECTION 2: Amoy (Burned) -> Sepolia (Unlock)
        // ---------------------------------------------------------------------
        const currentAmoyBlock = await withRetry(() => amoyProvider.getBlockNumber());
        const safeAmoyBlock = currentAmoyBlock - requiredConfirmationsAmoy;

        if (safeAmoyBlock > state.lastProcessedBlockAmoy) {
          const fromBlock = state.lastProcessedBlockAmoy + 1;
          const toBlock = Math.min(safeAmoyBlock, fromBlock + 500);

          const filter = bridgeDestination.filters.Burned();
          const events = await withRetry(() => bridgeDestination.queryFilter(filter, fromBlock, toBlock));

          for (const ev of events) {
            const eventLog = ev as ethers.EventLog;
            const txHash = eventLog.transactionHash;
            if (state.processedTxHashes[txHash]) continue;

            const { recipient, amount, messageId, nonce } = eventLog.args;
            log("INFO", `[Amoy -> Sepolia] Detected Burned event in tx ${txHash}: Nonce ${nonce}, Amount: ${ethers.formatEther(amount)} tokens`);

            const isAlreadyProcessed = await withRetry(() => bridgeSource.processedMessages(messageId));
            if (!isAlreadyProcessed) {
              log("INFO", `[Amoy -> Sepolia] Submitting unlockTokens() on Sepolia for messageId: ${messageId}`);
              const tx = await withRetry(() => bridgeSource.unlockTokens(messageId, recipient, amount));
              log("INFO", `[Amoy -> Sepolia] Unlock tx submitted: ${tx.hash}. Awaiting confirmation...`);
              await tx.wait();
              log("SUCCESS", `[Amoy -> Sepolia] Successfully unlocked on Sepolia! Tx: ${tx.hash}`);
            } else {
              log("WARN", `[Amoy -> Sepolia] Message ${messageId} was already processed on Sepolia. Skipping.`);
            }

            state.processedTxHashes[txHash] = true;
            saveState(state);
          }

          state.lastProcessedBlockAmoy = toBlock;
          saveState(state);
        }
      }
    } catch (err: any) {
      log("ERROR", `Error in relayer cycle: ${err.message || err}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

main().catch((err) => {
  log("ERROR", `Fatal error in relayer: ${err.message || err}`);
  process.exit(1);
});

