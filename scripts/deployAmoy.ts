import { ethers, run } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("====================================================");
  console.log("Deploying MiniBridge to Polygon Amoy Testnet");
  console.log("Deployer Address:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer Balance:", ethers.formatEther(balance), "POL (MATIC)");
  console.log("====================================================");

  if (balance === 0n) {
    console.error("ERROR: Deployer account has 0 POL. Please fund it from a Polygon Amoy faucet.");
    process.exit(1);
  }

  const relayerAddress = process.env.RELAYER_ADDRESS || deployer.address;
  console.log("Authorized Relayer Address:", relayerAddress);

  // 1. Deploy WrappedToken
  console.log("\n1. Deploying WrappedToken...");
  const WrappedToken = await ethers.getContractFactory("WrappedToken");
  const wrappedToken = await WrappedToken.deploy(deployer.address);
  await wrappedToken.waitForDeployment();
  const wrappedTokenAddress = await wrappedToken.getAddress();
  console.log(" WrappedToken deployed at:", wrappedTokenAddress);

  // 2. Deploy BridgeDestination (Mint/Burn Controller)
  console.log("\n2. Deploying BridgeDestination...");
  const BridgeDestination = await ethers.getContractFactory("BridgeDestination");
  const bridgeDestination = await BridgeDestination.deploy(
    wrappedTokenAddress,
    relayerAddress,
    deployer.address
  );
  await bridgeDestination.waitForDeployment();
  const bridgeDestinationAddress = await bridgeDestination.getAddress();
  console.log(" BridgeDestination deployed at:", bridgeDestinationAddress);

  // 3. Grant BridgeDestination exclusive minting and burning privileges
  console.log("\n3. Authorizing BridgeDestination as the controller of WrappedToken...");
  const setControllerTx = await wrappedToken.setBridgeController(bridgeDestinationAddress);
  await setControllerTx.wait();
  console.log(" BridgeDestination authorized successfully!");

  console.log("\n====================================================");
  console.log("AMOY DEPLOYMENT SUMMARY:");
  console.log(`AMOY_WRAPPED_TOKEN_ADDRESS="${wrappedTokenAddress}"`);
  console.log(`AMOY_BRIDGE_DESTINATION_ADDRESS="${bridgeDestinationAddress}"`);
  console.log("====================================================");

  // Optional Explorer Verification
  if (process.env.POLYGONSCAN_API_KEY) {
    console.log("\nAwaiting 5 block confirmations before Polygonscan verification...");
    await bridgeDestination.deploymentTransaction()?.wait(5);

    try {
      console.log("Verifying WrappedToken...");
      await run("verify:verify", {
        address: wrappedTokenAddress,
        constructorArguments: [deployer.address],
      });
    } catch (e: any) {
      console.log("WrappedToken verification notice:", e.message);
    }

    try {
      console.log("Verifying BridgeDestination...");
      await run("verify:verify", {
        address: bridgeDestinationAddress,
        constructorArguments: [wrappedTokenAddress, relayerAddress, deployer.address],
      });
    } catch (e: any) {
      console.log("BridgeDestination verification notice:", e.message);
    }
  }
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});

