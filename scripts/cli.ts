import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

// Chain IDs
const SEPOLIA_CHAIN_ID = 11155111n;
const AMOY_CHAIN_ID = 80002n;

async function main() {
  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = network.chainId;

  // Determine requested action from command-line arguments
  const args = process.argv.slice(2);
  const action = args.find((arg) => ["balances", "faucet", "lock", "burn"].includes(arg.toLowerCase())) || "balances";

  console.log("====================================================");
  console.log("MiniBridge CLI - Cross-Chain Interaction Tool");
  console.log("Active Account:", signer.address);
  console.log(`Connected Network: Chain ID ${chainId} (${chainId === SEPOLIA_CHAIN_ID ? "Ethereum Sepolia" : chainId === AMOY_CHAIN_ID ? "Polygon Amoy" : "Local/Other"})`);
  console.log(`Selected Action: ${action.toUpperCase()}`);
  console.log("====================================================");

  if (action === "balances") {
    const nativeBal = await ethers.provider.getBalance(signer.address);
    console.log(`Native Currency Balance: ${ethers.formatEther(nativeBal)}`);

    if (chainId === SEPOLIA_CHAIN_ID) {
      const tokenAddress = process.env.SEPOLIA_TEST_TOKEN_ADDRESS;
      if (tokenAddress) {
        const token = await ethers.getContractAt("TestToken", tokenAddress, signer);
        const tokenBal = await token.balanceOf(signer.address);
        console.log(`TestToken (BTT) Balance on Sepolia: ${ethers.formatEther(tokenBal)} BTT`);
      } else {
        console.log("Notice: SEPOLIA_TEST_TOKEN_ADDRESS not configured in .env");
      }
    } else if (chainId === AMOY_CHAIN_ID) {
      const wrappedAddress = process.env.AMOY_WRAPPED_TOKEN_ADDRESS;
      if (wrappedAddress) {
        const wrapped = await ethers.getContractAt("WrappedToken", wrappedAddress, signer);
        const wrappedBal = await wrapped.balanceOf(signer.address);
        console.log(`WrappedToken (wBTT) Balance on Amoy: ${ethers.formatEther(wrappedBal)} wBTT`);
      } else {
        console.log("Notice: AMOY_WRAPPED_TOKEN_ADDRESS not configured in .env");
      }
    }
  } else if (action === "faucet") {
    if (chainId !== SEPOLIA_CHAIN_ID) {
      console.error("Faucet is only available on Sepolia (Chain ID 11155111)");
      process.exit(1);
    }
    const tokenAddress = process.env.SEPOLIA_TEST_TOKEN_ADDRESS;
    if (!tokenAddress) {
      console.error("SEPOLIA_TEST_TOKEN_ADDRESS is missing in .env");
      process.exit(1);
    }
    const token = await ethers.getContractAt("TestToken", tokenAddress, signer);
    const amount = ethers.parseEther("100"); // 100 BTT
    console.log(`Requesting 100 BTT from TestToken faucet...`);
    const tx = await token.faucet(amount);
    console.log(`Faucet transaction submitted: https://sepolia.etherscan.io/tx/${tx.hash}`);
    await tx.wait();
    console.log(` Successfully minted 100 BTT to ${signer.address}!`);
  } else if (action === "lock") {
    if (chainId !== SEPOLIA_CHAIN_ID) {
      console.error("Lock is only available on Sepolia (Chain ID 11155111)");
      process.exit(1);
    }
    const tokenAddress = process.env.SEPOLIA_TEST_TOKEN_ADDRESS;
    const bridgeAddress = process.env.SEPOLIA_BRIDGE_SOURCE_ADDRESS;
    if (!tokenAddress || !bridgeAddress) {
      console.error("SEPOLIA_TEST_TOKEN_ADDRESS or SEPOLIA_BRIDGE_SOURCE_ADDRESS is missing in .env");
      process.exit(1);
    }

    const token = await ethers.getContractAt("TestToken", tokenAddress, signer);
    const bridge = await ethers.getContractAt("BridgeSource", bridgeAddress, signer);
    const lockAmount = ethers.parseEther("10"); // 10 BTT

    console.log(`Step 1: Checking ERC-20 approval for BridgeSource...`);
    const allowance = await token.allowance(signer.address, bridgeAddress);
    if (allowance < lockAmount) {
      console.log(`Approving BridgeSource to spend 10 BTT...`);
      const approveTx = await token.approve(bridgeAddress, ethers.MaxUint256);
      console.log(`Approval submitted: https://sepolia.etherscan.io/tx/${approveTx.hash}`);
      await approveTx.wait();
      console.log(` Approval confirmed!`);
    }

    console.log(`\nStep 2: Locking 10 BTT on Sepolia targeting Polygon Amoy...`);
    const lockTx = await bridge.lockTokens(signer.address, lockAmount, AMOY_CHAIN_ID);
    console.log(`Lock transaction submitted: https://sepolia.etherscan.io/tx/${lockTx.hash}`);
    const receipt = await lockTx.wait();
    console.log(` Lock confirmed on Sepolia!`);

    // Parse event logs
    const eventLog = bridge.interface.parseLog(receipt!.logs[1]);
    if (eventLog) {
      console.log("====================================================");
      console.log("EVENT PAYLOAD DETECTED:");
      console.log("Message ID:", eventLog.args.messageId);
      console.log("Transfer Nonce:", eventLog.args.nonce.toString());
      console.log("Recipient on Amoy:", eventLog.args.recipient);
      console.log("====================================================");
      console.log("The relayer daemon will pick up this event, wait for confirmations, and mint wBTT on Amoy!");
    }
  } else if (action === "burn") {
    if (chainId !== AMOY_CHAIN_ID) {
      console.error("Burn is only available on Polygon Amoy (Chain ID 80002)");
      process.exit(1);
    }
    const bridgeAddress = process.env.AMOY_BRIDGE_DESTINATION_ADDRESS;
    const wrappedAddress = process.env.AMOY_WRAPPED_TOKEN_ADDRESS;
    if (!bridgeAddress || !wrappedAddress) {
      console.error("AMOY_BRIDGE_DESTINATION_ADDRESS or AMOY_WRAPPED_TOKEN_ADDRESS is missing in .env");
      process.exit(1);
    }

    const bridge = await ethers.getContractAt("BridgeDestination", bridgeAddress, signer);
    const burnAmount = ethers.parseEther("5"); // 5 wBTT

    console.log(`Burning 5 wBTT on Polygon Amoy targeting Ethereum Sepolia...`);
    const burnTx = await bridge.burnTokens(burnAmount, signer.address, SEPOLIA_CHAIN_ID);
    console.log(`Burn transaction submitted: https://amoy.polygonscan.com/tx/${burnTx.hash}`);
    const receipt = await burnTx.wait();
    console.log(` Burn confirmed on Polygon Amoy!`);

    const eventLog = bridge.interface.parseLog(receipt!.logs[1]);
    if (eventLog) {
      console.log("====================================================");
      console.log("EVENT PAYLOAD DETECTED:");
      console.log("Message ID:", eventLog.args.messageId);
      console.log("Transfer Nonce:", eventLog.args.nonce.toString());
      console.log("Recipient on Sepolia:", eventLog.args.recipient);
      console.log("====================================================");
      console.log("The relayer daemon will pick up this event, wait for confirmations, and unlock BTT on Sepolia!");
    }
  }
}

main().catch((error) => {
  console.error("CLI Execution failed:", error);
  process.exit(1);
});

