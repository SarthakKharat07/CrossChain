import { ethers, run } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("====================================================");
  console.log("Deploying MiniBridge to Ethereum Sepolia Testnet");
  console.log("Deployer Address:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer Balance:", ethers.formatEther(balance), "SepoliaETH");
  console.log("====================================================");

  if (balance === 0n) {
    console.error("ERROR: Deployer account has 0 SepoliaETH. Please fund it from a Sepolia faucet.");
    process.exit(1);
  }

  const relayerAddress = process.env.RELAYER_ADDRESS || deployer.address;
  console.log("Authorized Relayer Address:", relayerAddress);

  // 1. Deploy TestToken
  console.log("\n1. Deploying TestToken...");
  const TestToken = await ethers.getContractFactory("TestToken");
  const testToken = await TestToken.deploy(deployer.address);
  await testToken.waitForDeployment();
  const testTokenAddress = await testToken.getAddress();
  console.log(" TestToken deployed at:", testTokenAddress);

  // 2. Deploy BridgeSource
  console.log("\n2. Deploying BridgeSource (Lock Escrow)...");
  const BridgeSource = await ethers.getContractFactory("BridgeSource");
  const bridgeSource = await BridgeSource.deploy(
    testTokenAddress,
    relayerAddress,
    deployer.address
  );
  await bridgeSource.waitForDeployment();
  const bridgeSourceAddress = await bridgeSource.getAddress();
  console.log(" BridgeSource deployed at:", bridgeSourceAddress);

  console.log("\n====================================================");
  console.log("SEPOLIA DEPLOYMENT SUMMARY:");
  console.log(`SEPOLIA_TEST_TOKEN_ADDRESS="${testTokenAddress}"`);
  console.log(`SEPOLIA_BRIDGE_SOURCE_ADDRESS="${bridgeSourceAddress}"`);
  console.log("====================================================");

  // Optional Explorer Verification
  if (process.env.ETHERSCAN_API_KEY) {
    console.log("\nAwaiting 5 block confirmations before Etherscan verification...");
    await bridgeSource.deploymentTransaction()?.wait(5);

    try {
      console.log("Verifying TestToken...");
      await run("verify:verify", {
        address: testTokenAddress,
        constructorArguments: [deployer.address],
      });
    } catch (e: any) {
      console.log("TestToken verification notice:", e.message);
    }

    try {
      console.log("Verifying BridgeSource...");
      await run("verify:verify", {
        address: bridgeSourceAddress,
        constructorArguments: [testTokenAddress, relayerAddress, deployer.address],
      });
    } catch (e: any) {
      console.log("BridgeSource verification notice:", e.message);
    }
  }
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});

