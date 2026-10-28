import { expect } from "chai";
import { ethers } from "hardhat";
import {
  TestToken,
  BridgeSource,
  WrappedToken,
  BridgeDestination,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("MiniBridge Cross-Chain Bridge Test Suite", function () {
  let owner: HardhatEthersSigner;
  let relayer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  let testToken: TestToken;
  let bridgeSource: BridgeSource;
  let wrappedToken: WrappedToken;
  let bridgeDestination: BridgeDestination;

  const SEPOLIA_CHAIN_ID = 11155111n;
  const AMOY_CHAIN_ID = 80002n;
  const INITIAL_MINT = ethers.parseEther("1000");
  const BRIDGE_AMOUNT = ethers.parseEther("100");

  beforeEach(async function () {
    [owner, relayer, user, attacker] = await ethers.getSigners();

    // 1. Deploy TestToken (Original ERC-20 on Sepolia)
    const TestTokenFactory = await ethers.getContractFactory("TestToken");
    testToken = (await TestTokenFactory.deploy(owner.address)) as TestToken;
    await testToken.waitForDeployment();

    // 2. Deploy BridgeSource (Sepolia Escrow)
    const BridgeSourceFactory = await ethers.getContractFactory("BridgeSource");
    bridgeSource = (await BridgeSourceFactory.deploy(
      await testToken.getAddress(),
      relayer.address,
      owner.address
    )) as BridgeSource;
    await bridgeSource.waitForDeployment();

    // 3. Deploy WrappedToken (Polygon Amoy Synthetic)
    const WrappedTokenFactory = await ethers.getContractFactory("WrappedToken");
    wrappedToken = (await WrappedTokenFactory.deploy(owner.address)) as WrappedToken;
    await wrappedToken.waitForDeployment();

    // 4. Deploy BridgeDestination (Amoy Controller)
    const BridgeDestinationFactory = await ethers.getContractFactory("BridgeDestination");
    bridgeDestination = (await BridgeDestinationFactory.deploy(
      await wrappedToken.getAddress(),
      relayer.address,
      owner.address
    )) as BridgeDestination;
    await bridgeDestination.waitForDeployment();

    // 5. Authorize BridgeDestination as the exclusive controller on WrappedToken
    await wrappedToken.setBridgeController(await bridgeDestination.getAddress());

    // 6. Fund the user with TestTokens and approve BridgeSource
    await testToken.connect(user).faucet(INITIAL_MINT);
    await testToken.connect(user).approve(await bridgeSource.getAddress(), ethers.MaxUint256);
  });

  describe("1. Happy Path: Full Round-Trip (Lock -> Mint -> Burn -> Unlock)", function () {
    it("should successfully lock tokens on Sepolia and emit Locked event", async function () {
      const balanceBefore = await testToken.balanceOf(user.address);

      const tx = await bridgeSource.connect(user).lockTokens(
        user.address,
        BRIDGE_AMOUNT,
        AMOY_CHAIN_ID
      );

      // Verify token transfer to escrow
      expect(await testToken.balanceOf(user.address)).to.equal(balanceBefore - BRIDGE_AMOUNT);
      expect(await testToken.balanceOf(await bridgeSource.getAddress())).to.equal(BRIDGE_AMOUNT);

      // Verify event emission
      await expect(tx)
        .to.emit(bridgeSource, "Locked")
        .withArgs(
          user.address,
          user.address,
          await testToken.getAddress(),
          BRIDGE_AMOUNT,
          0n, // first nonce
          AMOY_CHAIN_ID,
          (val: string) => typeof val === "string" && val.startsWith("0x")
        );
    });

    it("should allow the relayer to mint wrapped tokens upon valid messageId", async function () {
      const lockTx = await bridgeSource.connect(user).lockTokens(
        user.address,
        BRIDGE_AMOUNT,
        AMOY_CHAIN_ID
      );
      const receipt = await lockTx.wait();
      const lockEvent = bridgeSource.interface.parseLog(receipt!.logs[1]);
      const messageId = lockEvent!.args.messageId;

      // Relayer mints wrapped token on destination
      await expect(bridgeDestination.connect(relayer).mintWrapped(messageId, user.address, BRIDGE_AMOUNT))
        .to.emit(bridgeDestination, "Minted")
        .withArgs(messageId, user.address, BRIDGE_AMOUNT);

      expect(await wrappedToken.balanceOf(user.address)).to.equal(BRIDGE_AMOUNT);
    });

    it("should complete a full round trip: burn on Amoy and unlock on Sepolia", async function () {
      // Step A: Lock & Mint
      const lockTx = await bridgeSource.connect(user).lockTokens(user.address, BRIDGE_AMOUNT, AMOY_CHAIN_ID);
      const lockReceipt = await lockTx.wait();
      const lockMessageId = bridgeSource.interface.parseLog(lockReceipt!.logs[1])!.args.messageId;

      await bridgeDestination.connect(relayer).mintWrapped(lockMessageId, user.address, BRIDGE_AMOUNT);
      expect(await wrappedToken.balanceOf(user.address)).to.equal(BRIDGE_AMOUNT);

      // Step B: Burn on Amoy
      const burnTx = await bridgeDestination.connect(user).burnTokens(BRIDGE_AMOUNT, user.address, SEPOLIA_CHAIN_ID);
      const burnReceipt = await burnTx.wait();
      const burnLog = bridgeDestination.interface.parseLog(burnReceipt!.logs[1]);
      const burnMessageId = burnLog!.args.messageId;

      // Verify tokens burned
      expect(await wrappedToken.balanceOf(user.address)).to.equal(0n);

      // Step C: Relayer unlocks on Sepolia
      const balanceBeforeUnlock = await testToken.balanceOf(user.address);
      await expect(bridgeSource.connect(relayer).unlockTokens(burnMessageId, user.address, BRIDGE_AMOUNT))
        .to.emit(bridgeSource, "Unlocked")
        .withArgs(burnMessageId, user.address, BRIDGE_AMOUNT);

      expect(await testToken.balanceOf(user.address)).to.equal(balanceBeforeUnlock + BRIDGE_AMOUNT);
      expect(await testToken.balanceOf(await bridgeSource.getAddress())).to.equal(0n);
    });
  });

  describe("2. Replay Protection", function () {
    it("should reject duplicate mint execution with MessageAlreadyProcessed", async function () {
      const dummyMessageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-1"));

      await bridgeDestination.connect(relayer).mintWrapped(dummyMessageId, user.address, BRIDGE_AMOUNT);

      // Second attempt must revert
      await expect(
        bridgeDestination.connect(relayer).mintWrapped(dummyMessageId, user.address, BRIDGE_AMOUNT)
      ).to.be.revertedWithCustomError(bridgeDestination, "MessageAlreadyProcessed")
       .withArgs(dummyMessageId);
    });

    it("should reject duplicate unlock execution with MessageAlreadyProcessed", async function () {
      const dummyMessageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-2"));

      // Deposit tokens in escrow first
      await bridgeSource.connect(user).lockTokens(user.address, BRIDGE_AMOUNT, AMOY_CHAIN_ID);

      // First unlock succeeds
      await bridgeSource.connect(relayer).unlockTokens(dummyMessageId, user.address, BRIDGE_AMOUNT);

      // Second unlock attempt must revert
      await expect(
        bridgeSource.connect(relayer).unlockTokens(dummyMessageId, user.address, BRIDGE_AMOUNT)
      ).to.be.revertedWithCustomError(bridgeSource, "MessageAlreadyProcessed")
       .withArgs(dummyMessageId);
    });
  });

  describe("3. Access Control & Authorization", function () {
    it("should prevent unauthorized callers from minting wrapped tokens", async function () {
      const dummyMessageId = ethers.keccak256(ethers.toUtf8Bytes("unauthorized-mint"));

      await expect(
        bridgeDestination.connect(attacker).mintWrapped(dummyMessageId, attacker.address, BRIDGE_AMOUNT)
      ).to.be.revertedWithCustomError(bridgeDestination, "CallerNotRelayer")
       .withArgs(attacker.address);
    });

    it("should prevent unauthorized callers from unlocking escrowed tokens", async function () {
      const dummyMessageId = ethers.keccak256(ethers.toUtf8Bytes("unauthorized-unlock"));

      await expect(
        bridgeSource.connect(attacker).unlockTokens(dummyMessageId, attacker.address, BRIDGE_AMOUNT)
      ).to.be.revertedWithCustomError(bridgeSource, "CallerNotRelayer")
       .withArgs(attacker.address);
    });

    it("should reject direct mint calls on WrappedToken not coming from controller", async function () {
      await expect(
        wrappedToken.connect(attacker).mint(attacker.address, BRIDGE_AMOUNT)
      ).to.be.revertedWithCustomError(wrappedToken, "CallerNotController")
       .withArgs(attacker.address);
    });

    it("should reject direct burn calls on WrappedToken not coming from controller", async function () {
      await expect(
        wrappedToken.connect(attacker).burn(attacker.address, BRIDGE_AMOUNT)
      ).to.be.revertedWithCustomError(wrappedToken, "CallerNotController")
       .withArgs(attacker.address);
    });
  });

  describe("4. Circuit Breakers (Pausing)", function () {
    it("should block locking when BridgeSource is paused", async function () {
      await bridgeSource.connect(owner).pause();

      await expect(
        bridgeSource.connect(user).lockTokens(user.address, BRIDGE_AMOUNT, AMOY_CHAIN_ID)
      ).to.be.revertedWithCustomError(bridgeSource, "EnforcedPause");
    });

    it("should block unlocking when BridgeSource is paused", async function () {
      await bridgeSource.connect(owner).pause();
      const dummyMessageId = ethers.keccak256(ethers.toUtf8Bytes("pause-test"));

      await expect(
        bridgeSource.connect(relayer).unlockTokens(dummyMessageId, user.address, BRIDGE_AMOUNT)
      ).to.be.revertedWithCustomError(bridgeSource, "EnforcedPause");
    });

    it("should block burning when BridgeDestination is paused", async function () {
      await bridgeDestination.connect(owner).pause();

      await expect(
        bridgeDestination.connect(user).burnTokens(BRIDGE_AMOUNT, user.address, SEPOLIA_CHAIN_ID)
      ).to.be.revertedWithCustomError(bridgeDestination, "EnforcedPause");
    });

    it("should reject pause calls from non-owner", async function () {
      await expect(
        bridgeSource.connect(attacker).pause()
      ).to.be.revertedWithCustomError(bridgeSource, "OwnableUnauthorizedAccount")
       .withArgs(attacker.address);
    });
  });

  describe("5. Input Validation & Edge Cases", function () {
    it("should revert if locking zero amount", async function () {
      await expect(
        bridgeSource.connect(user).lockTokens(user.address, 0n, AMOY_CHAIN_ID)
      ).to.be.revertedWithCustomError(bridgeSource, "ZeroAmount");
    });

    it("should revert if locking with zero address recipient", async function () {
      await expect(
        bridgeSource.connect(user).lockTokens(ethers.ZeroAddress, BRIDGE_AMOUNT, AMOY_CHAIN_ID)
      ).to.be.revertedWithCustomError(bridgeSource, "ZeroAddress");
    });

    it("should revert if locking targeting the same chain", async function () {
      const currentChain = (await ethers.provider.getNetwork()).chainId;
      await expect(
        bridgeSource.connect(user).lockTokens(user.address, BRIDGE_AMOUNT, currentChain)
      ).to.be.revertedWithCustomError(bridgeSource, "SameChainNotAllowed")
       .withArgs(currentChain);
    });

    it("should revert if requesting more than faucet limit on TestToken", async function () {
      const oversizedAmount = ethers.parseEther("1001");
      await expect(
        testToken.connect(user).faucet(oversizedAmount)
      ).to.be.revertedWithCustomError(testToken, "FaucetLimitExceeded");
    });
  });
});

