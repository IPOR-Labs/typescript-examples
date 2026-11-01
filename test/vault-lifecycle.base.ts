// PROTOTYPE, throwaway. Story: create a vault, put USDC into Aave V3, and take money out
// both ways the webapp offers: instantly from idle funds, and scheduled when idle is short.
// Every step is a real transaction on a Base fork. A step depends on the steps above it.
// This shows the transaction flow, so it skips simulation. A real app on a real chain should
// simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, parseEther, parseEventLogs, parseUnits, pad, type Address } from "viem";

// Base addresses, from ipor-abi: mainnet/addresses.json and mainnet/mainnet-base-fusion/addresses.json.
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const AAVE_SUPPLY_FUSE = "0x26fD6EF391E98C78CfCA27e00c3d15be4D941625";
const AAVE_BALANCE_FUSE = "0x952573Ec1B6895a88a95CA523097083d4da4D8e5";
const ERC20_BALANCE_FUSE = "0x9ba147FC382DBf4D73512A45370ba0B70c25F6aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_WHALE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"; // Morpho Blue

// IporFusionMarkets.sol and Roles.sol.
const AAVE_V3_MARKET = 1n;
const ERC20_MARKET = 7n;
const ATOMIST_ROLE = 100n;
const ALPHA_ROLE = 200n;
const FUSE_MANAGER_ROLE = 300n;

// PlasmaVault has no getter for its Withdraw Manager. PlasmaVaultStorageLib.sol names this slot.
const WITHDRAW_MANAGER_SLOT = "0x465d2ff0062318fe6f4c7e9ac78cfcd70bc86a1d992722875ef83a9770513100";

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ALPHA = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (uint256)",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
const vaultAbi = parseAbi([
  "struct FuseAction { address fuse; bytes data; }",
  "function getAccessManagerAddress() view returns (address)",
  "function getPriceOracleMiddleware() view returns (address)",
  "function addFuses(address[] fuses)",
  "function addBalanceFuse(uint256 marketId, address fuse)",
  "function grantMarketSubstrates(uint256 marketId, bytes32[] substrates)",
  "function updateDependencyBalanceGraphs(uint256[] marketIds, uint256[][] dependencies)",
  "function convertToPublicVault()",
  "function execute(FuseAction[] calls)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function redeemFromRequest(uint256 shares, address receiver, address owner) returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
]);
const accessManagerAbi = parseAbi(["function grantRole(uint64 roleId, address account, uint32 executionDelay)"]);
const feeManagerAbi = parseAbi(["function getDepositFee() view returns (uint256)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256 price, uint256 decimals)"]);
const withdrawManagerAbi = parseAbi([
  "struct RequestInfo { uint256 shares; uint256 endWithdrawWindowTimestamp; bool canWithdraw; uint256 withdrawWindowInSeconds; }",
  "function requestShares(uint256 shares)",
  "function releaseFunds(uint256 timestamp, uint256 shares)",
  "function requestInfo(address) view returns (RequestInfo)",
  "function getSharesToRelease() view returns (uint256)",
  "function getWithdrawWindow() view returns (uint256)",
  "function getWithdrawFee() view returns (uint256)",
  "function getRequestFee() view returns (uint256)",
]);
const aaveSupplyFuseAbi = parseAbi([
  "struct Enter { address asset; uint256 amount; uint256 userEModeCategoryId; }",
  "struct Exit { address asset; uint256 amount; }",
  "function enter(Enter data)",
  "function exit(Exit data)",
]);

const usdc = (amount: string) => parseUnits(amount, 6);

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const alpha = await viem.getWalletClient(ALPHA);
const alice = await viem.getWalletClient(ALICE);

const usdcBalance = (account: Address) => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] });

describe("USDC vault on Aave V3, from creation to scheduled withdrawal", () => {
  let vault: Address, accessManager: Address, feeManager: Address, withdrawManager: Address;
  const shareBalance = () => publicClient.readContract({ address: vault, abi: erc20Abi, functionName: "balanceOf", args: [ALICE] });
  const idle = () => usdcBalance(vault);

  before(async () => {
    for (const account of [OWNER, ALPHA, ALICE, USDC_WHALE]) {
      await networkHelpers.impersonateAccount(account);
      await networkHelpers.setBalance(account, parseEther("1"));
    }
    const whale = await viem.getWalletClient(USDC_WHALE);
    await whale.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [ALICE, usdc("1000")] });
  });

  it("01 clones a vault from the factory", async () => {
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Story USDC", "sUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.getTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    vault = created.args.plasmaVault;
    feeManager = created.args.feeManager;
    accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });
    const slot = await publicClient.getStorageAt({ address: vault, slot: WITHDRAW_MANAGER_SLOT });
    withdrawManager = getAddress(`0x${slot!.slice(-40)}`);
  });

  it("02 grants roles: the owner can only grant Atomist, and the Atomist grants the rest", async () => {
    const grant = (roleId: bigint, account: Address) => owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [roleId, account, 0] });
    await grant(ATOMIST_ROLE, OWNER);
    await grant(FUSE_MANAGER_ROLE, OWNER);
    await grant(ALPHA_ROLE, ALPHA);
  });

  it("03 installs Aave V3: fuses, balance fuses, substrates, then the dependency", async () => {
    await owner.writeContract({ address: vault, abi: vaultAbi, functionName: "addFuses", args: [[AAVE_SUPPLY_FUSE]] });
    await owner.writeContract({ address: vault, abi: vaultAbi, functionName: "addBalanceFuse", args: [AAVE_V3_MARKET, AAVE_BALANCE_FUSE] });
    await owner.writeContract({ address: vault, abi: vaultAbi, functionName: "addBalanceFuse", args: [ERC20_MARKET, ERC20_BALANCE_FUSE] });
    // grantMarketSubstrates replaces the whole list. An address substrate is left-padded to 32 bytes.
    const usdcSubstrate = pad(USDC, { size: 32 });
    await owner.writeContract({ address: vault, abi: vaultAbi, functionName: "grantMarketSubstrates", args: [AAVE_V3_MARKET, [usdcSubstrate]] });
    await owner.writeContract({ address: vault, abi: vaultAbi, functionName: "grantMarketSubstrates", args: [ERC20_MARKET, [usdcSubstrate]] });
    await owner.writeContract({ address: vault, abi: vaultAbi, functionName: "updateDependencyBalanceGraphs", args: [[AAVE_V3_MARKET], [[ERC20_MARKET]]] });
  });

  it("04 opens deposits to everyone", async () => {
    await owner.writeContract({ address: vault, abi: vaultAbi, functionName: "convertToPublicVault" });
  });

  it("05 reads what the deposit form shows", async () => {
    const amount = usdc("1000");
    const balance = await usdcBalance(ALICE);
    const oracle = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getPriceOracleMiddleware" });
    const [price] = await publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [USDC] });
    const depositFee = await publicClient.readContract({ address: feeManager, abi: feeManagerAbi, functionName: "getDepositFee" });
    const limit = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "maxDeposit", args: [ALICE] });
    const window = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getWithdrawWindow" });

    console.log("deposit form", {
      "Balance": balance,
      "USD value (18 decimals)": (amount * price) / 10n ** 6n,
      "Onboarding contribution": depositFee, // row hidden at 0
      "Withdraw: Scheduled (seconds)": window - window / 2n,
    });
    assert.equal(balance, amount);
    assert.ok(limit >= amount, "submit is disabled above maxDeposit");
  });

  it("06 Direct deposit: approve, then deposit", async () => {
    const amount = usdc("1000");
    await alice.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, amount] });
    await alice.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [amount, ALICE] });

    assert.equal(await usdcBalance(ALICE), 0n);
    assert.equal(await idle(), amount);
    assert.ok((await shareBalance()) > 0n);
  });

  it("07 Alpha supplies 800 USDC to Aave V3, leaving 200 idle", async () => {
    const totalBefore = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" });
    const data = encodeFunctionData({ abi: aaveSupplyFuseAbi, functionName: "enter", args: [{ asset: USDC, amount: usdc("800"), userEModeCategoryId: 0n }] });
    await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[{ fuse: AAVE_SUPPLY_FUSE, data }]] });

    assert.equal(await idle(), usdc("200"));
    const totalAfter = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" });
    assert.ok(totalAfter >= totalBefore - 1n, "supplying must not lose value");
  });

  it("08 Withdraw Now: 100 USDC comes from idle funds", async () => {
    // The webapp finds "Max instant withdraw" by simulating. With no instant-withdrawal fuses it is idle minus released shares.
    const released = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getSharesToRelease" });
    const reserved = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [released] });
    const maxInstant = (await idle()) - reserved;
    const amount = usdc("100");
    const fee = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getWithdrawFee" });
    console.log("withdraw form", { "Max instant withdraw": maxInstant, "Off-boarding": fee, "Payout": amount - (amount * fee) / parseEther("1") });
    assert.equal(maxInstant, usdc("200"));

    await alice.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [amount, ALICE, ALICE] });
    assert.equal(await usdcBalance(ALICE), amount);
    assert.equal(await idle(), usdc("100"));
  });

  it("09 Withdraw Now fails above idle, which is why the form switches to Scheduled", async () => {
    await assert.rejects(alice.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [usdc("500"), ALICE, ALICE] }));
  });

  it("10 Schedule Withdrawal: request shares worth 500 USDC", async () => {
    const shares = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToShares", args: [usdc("500")] });
    const sharesBefore = await shareBalance();
    await alice.writeContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "requestShares", args: [shares] });

    const request = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "requestInfo", args: [ALICE] });
    assert.equal(request.shares, shares);
    assert.equal(request.canWithdraw, false, "the Alpha has not released funds yet");
    assert.equal(await shareBalance(), sharesBefore, "a request does not lock shares");
  });

  it("11 Alpha pulls 500 USDC from Aave V3 and releases the request", async () => {
    const { timestamp } = await publicClient.getBlock();
    await networkHelpers.time.increase(60);
    const data = encodeFunctionData({ abi: aaveSupplyFuseAbi, functionName: "exit", args: [{ asset: USDC, amount: usdc("500") }] });
    await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[{ fuse: AAVE_SUPPLY_FUSE, data }]] });

    const { shares } = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "requestInfo", args: [ALICE] });
    // Only requests before the timestamp are released, so it is the request's block time plus one.
    await alpha.writeContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "releaseFunds", args: [timestamp + 1n, shares] });

    const request = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "requestInfo", args: [ALICE] });
    assert.equal(request.canWithdraw, true);
  });

  it("12 Redeem: Alice takes the released shares", async () => {
    const { shares } = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "requestInfo", args: [ALICE] });
    const before = await usdcBalance(ALICE);
    await alice.writeContract({ address: vault, abi: vaultAbi, functionName: "redeemFromRequest", args: [shares, ALICE, ALICE] });

    const received = (await usdcBalance(ALICE)) - before;
    assert.ok(received >= usdc("499.9"), `received ${received}`); // fees accrue between steps, so exact equality fails
  });

  it("13 Withdraw All Now: Alpha exits Aave V3 and Alice redeems the rest", async () => {
    const data = encodeFunctionData({ abi: aaveSupplyFuseAbi, functionName: "exit", args: [{ asset: USDC, amount: usdc("301") }] });
    await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[{ fuse: AAVE_SUPPLY_FUSE, data }]] });

    const shares = await shareBalance();
    await alice.writeContract({ address: vault, abi: vaultAbi, functionName: "redeem", args: [shares, ALICE, ALICE] });

    assert.equal(await shareBalance(), 0n);
    assert.ok((await usdcBalance(ALICE)) >= usdc("999.9"));
  });
});
