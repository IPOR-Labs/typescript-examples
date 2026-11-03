// S11 Governance: an execution delay floor, a timelocked Atomist, schedule and execute,
// a Guardian cancelling a scheduled call, and a Guardian pausing and unpausing the vault.
// It stands alone: step 01 repeats S1's clone, Atomist grant and convertToPublicVault in short,
// with no market: every deposit stays idle in the vault.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, erc20Abi, parseAbi, parseEther, parseEventLogs, parseUnits, type Address } from "viem";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// An EOA holding about 158.3M USDC at the fork block funds the depositor.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";

// Role IDs from Roles.sol (ipor-fusion 4fdaf50).
const ATOMIST_ROLE = 100n;
const GUARDIAN_ROLE = 2n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SECOND_ATOMIST = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const GUARDIAN = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

const ONE_HOUR = 3600;

// ABIs from ipor-abi (mainnet/mainnet-base-fusion/abis; IporFusionFactoryImpl and IporFusionAccessManagerBase at 55b2d9e,
// PlasmaVaultBase at b942366): IporFusionFactory, PlasmaVault (with PlasmaVaultGovernance) and IporFusionAccessManager.
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
const vaultAbi = parseAbi([
  "function getAccessManagerAddress() view returns (address)",
  "function convertToPublicVault()",
  "function setMinimalExecutionDelaysForRoles(uint64[] rolesIds, uint256[] delays)",
  "function setTotalSupplyCap(uint256 cap)",
  "function getTotalSupplyCap() view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "error AccessManagedUnauthorized(address caller)",
  // Raised by the access manager inside a vault call when the caller's role has an execution delay.
  "error AccessManagerNotScheduled(bytes32 operationId)",
]);
const accessManagerAbi = parseAbi([
  "function grantRole(uint64 roleId, address account, uint32 executionDelay)",
  "function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)",
  "function schedule(address target, bytes data, uint48 when) returns (bytes32 operationId, uint32 nonce)",
  "function execute(address target, bytes data) payable returns (uint32)",
  "function cancel(address caller, address target, bytes data) returns (uint32)",
  "function updateTargetClosed(address target, bool closed)",
  "function isTargetClosed(address target) view returns (bool)",
  "error TooShortExecutionDelayForRole(uint64 roleId, uint32 executionDelay)",
  "error AccessManagerNotScheduled(bytes32 operationId)",
  "error AccessManagerNotReady(bytes32 operationId)",
]);

const usdc = (amount: string) => parseUnits(amount, 6);
// The supply cap is in shares: 8 decimals, USDC's 6 plus the vault's offset of 2.
const shares = (amount: string) => parseUnits(amount, 8);

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);
const guardian = await viem.getWalletClient(GUARDIAN);

describe("S11 Govern a USDC vault: timelock, cancel and pause", () => {
  let vault: Address, accessManager: Address;
  const roleMembership = (roleId: bigint, account: Address) =>
    publicClient.readContract({ address: accessManager, abi: accessManagerAbi, functionName: "hasRole", args: [roleId, account] });
  const totalSupplyCap = () => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getTotalSupplyCap" });
  const deposit = (amount: bigint) => depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [amount, DEPOSITOR] });

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas for its USDC transfer.
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(USDC_WHALE);
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [DEPOSITOR, usdc("1000")] }) });
  });

  it("01 clones a vault, grants Atomist and opens deposits to everyone, as in S1", async () => {
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Story USDC", "sUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    vault = created.args.plasmaVault;
    accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] }) });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "convertToPublicVault" }) });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, usdc("1000")] }) });

    assert.deepEqual(await roleMembership(ATOMIST_ROLE, ATOMIST), [true, 0]);
  });

  it("02 the Owner sets a one-hour floor for Atomist, which binds only new grants", async () => {
    // On the vault, Owner only: the minimal execution delay a new grant of each role must carry.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: vault, abi: vaultAbi, functionName: "setMinimalExecutionDelaysForRoles", args: [[ATOMIST_ROLE], [BigInt(ONE_HOUR)]] }) });

    // The existing Atomist keeps delay 0: a floor alone timelocks no one.
    assert.deepEqual(await roleMembership(ATOMIST_ROLE, ATOMIST), [true, 0]);
    await assert.rejects(
      // Expected to revert: a new Atomist grant below the floor.
      owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, SECOND_ATOMIST, 0] }),
      /TooShortExecutionDelayForRole/,
    );
  });

  it("03 the Owner re-grants Atomist with a one-hour delay", async () => {
    // A timelock is applied per account, by granting the role again with an execution delay.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, ONE_HOUR] }) });

    assert.deepEqual(await roleMembership(ATOMIST_ROLE, ATOMIST), [true, ONE_HOUR]);
  });

  it("04 a direct Atomist call now reverts", async () => {
    await assert.rejects(
      // Expected to revert: a delayed role must schedule its calls first.
      atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "setTotalSupplyCap", args: [shares("1000000")] }),
      /AccessManagerNotScheduled/,
    );
  });

  it("05 the Atomist schedules the call, waits out the delay and executes it", async () => {
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "setTotalSupplyCap", args: [shares("1000000")] });
    // On the access manager: when 0 means now plus the caller's delay.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "schedule", args: [vault, data, 0] }) });
    await assert.rejects(
      // Expected to revert: the delay has not passed yet.
      atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "execute", args: [vault, data] }),
      /AccessManagerNotReady/,
    );

    await networkHelpers.time.increase(ONE_HOUR);
    // Only the account that scheduled the call may execute it.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "execute", args: [vault, data] }) });

    assert.equal(await totalSupplyCap(), shares("1000000"));
  });

  it("06 the Owner grants Guardian, and the Guardian cancels a scheduled call", async () => {
    // Guardian is administered by the Owner and guards every function role, so it may cancel any scheduled call.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [GUARDIAN_ROLE, GUARDIAN, 0] }) });
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "setTotalSupplyCap", args: [shares("1")] });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "schedule", args: [vault, data, 0] }) });

    // cancel names the account that scheduled the call, the target and the calldata.
    await publicClient.waitForTransactionReceipt({ hash: await guardian.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "cancel", args: [ATOMIST, vault, data] }) });
    await networkHelpers.time.increase(ONE_HOUR);

    assert.deepEqual(await roleMembership(GUARDIAN_ROLE, GUARDIAN), [true, 0]);
    await assert.rejects(
      // Expected to revert: the cancelled call is no longer scheduled.
      atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "execute", args: [vault, data] }),
      /AccessManagerNotScheduled/,
    );
    assert.equal(await totalSupplyCap(), shares("1000000"));
  });

  it("07 the Guardian pauses the vault, views still answer, then unpauses it", async () => {
    await publicClient.waitForTransactionReceipt({ hash: await deposit(usdc("100")) });
    // On the access manager: closing the vault as a target blocks every restricted vault call,
    // deposit, withdraw, transfer, schedule and harvestAllFees included. The vault has no pause() of its own.
    await publicClient.waitForTransactionReceipt({ hash: await guardian.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "updateTargetClosed", args: [vault, true] }) });

    assert.equal(await publicClient.readContract({ address: accessManager, abi: accessManagerAbi, functionName: "isTargetClosed", args: [vault] }), true);
    await assert.rejects(
      // Expected to revert: the vault is closed.
      deposit(usdc("100")),
      /AccessManagedUnauthorized/,
    );
    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" }), usdc("100"));
    // maxDeposit does not know about the pause and stays non-zero: a deposit form must check isTargetClosed itself.
    assert.ok((await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "maxDeposit", args: [DEPOSITOR] })) > 0n);

    await publicClient.waitForTransactionReceipt({ hash: await guardian.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "updateTargetClosed", args: [vault, false] }) });
    await publicClient.waitForTransactionReceipt({ hash: await deposit(usdc("100")) });

    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" }), usdc("200"));
  });
});
