// S9 Scheduled withdraw: when every dollar sits in a market, a depositor requests a withdrawal,
// the Alpha frees the funds and releases them, and the depositor redeems from the request
// inside its window. Then a partial release, a request that overwrites another, and expiry.
// It follows S1: steps 01 and 02 repeat S1's setup in short, then two depositors fund the vault.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, parseEther, parseEventLogs, parseUnits, pad, slice, zeroAddress, type Address } from "viem";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory, Aave V3 fuses),
// mainnet/addresses.json at e228075 (BalanceFuseErc20) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const AAVE_V3_SUPPLY_FUSE = "0x26fD6EF391E98C78CfCA27e00c3d15be4D941625";
const AAVE_V3_BALANCE_FUSE = "0x952573Ec1B6895a88a95CA523097083d4da4D8e5";
const ERC20_BALANCE_FUSE = "0x9ba147FC382DBf4D73512A45370ba0B70c25F6aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// An EOA that holds enough USDC on Base at the fork block to fund both depositors.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";
// The vault keeps its Withdraw Manager's address in this storage slot and has no getter for it
// (PlasmaVaultStorageLib.sol:722, ipor-fusion 004d054). The factory's event does not carry it either.
const WITHDRAW_MANAGER_SLOT = "0x465d2ff0062318fe6f4c7e9ac78cfcd70bc86a1d992722875ef83a9770513100";

// Market IDs from IporFusionMarkets.sol (ipor-fusion 004d054) and role IDs from Roles.sol (ipor-fusion 4fdaf50).
const AAVE_V3_MARKET = 1n;
const ERC20_VAULT_BALANCE_MARKET = 7n;
const ATOMIST_ROLE = 100n;
const ALPHA_ROLE = 200n;
const FUSE_MANAGER_ROLE = 300n;
const WITHDRAW_MANAGER_REQUEST_FEE_ROLE = 901n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FUSE_MANAGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ALPHA = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const DEPOSITOR_A = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const DEPOSITOR_B = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const REQUEST_FEE_MANAGER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

// ABIs from ipor-abi (mainnet/mainnet-base-fusion/abis; IporFusionFactoryImpl, IporFusionAccessManagerBase,
// IporFusionPlasmaVaultCoreBase and IporFusionWithdrawManagerBase at 55b2d9e, PlasmaVaultBase at b942366): IporFusionFactory,
// PlasmaVault (with PlasmaVaultGovernance), IporFusionAccessManager, AaveV3SupplyFuse and WithdrawManager.
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
const vaultAbi = parseAbi([
  "struct FuseAction { address fuse; bytes data; }",
  "function getAccessManagerAddress() view returns (address)",
  "function addFuses(address[] fuses)",
  "function addBalanceFuse(uint256 marketId, address fuse)",
  "function grantMarketSubstrates(uint256 marketId, bytes32[] substrates)",
  "function updateDependencyBalanceGraphs(uint256[] marketIds, uint256[][] dependencies)",
  "function convertToPublicVault()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function redeemFromRequest(uint256 shares, address receiver, address owner) returns (uint256)",
  "function execute(FuseAction[] calls)",
  "function balanceOf(address account) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "error WithdrawManagerInvalidSharesToRelease(uint256 sharesToRelease)",
]);
const accessManagerAbi = parseAbi(["function grantRole(uint64 roleId, address account, uint32 executionDelay)"]);
const aaveV3SupplyFuseAbi = parseAbi([
  "struct Enter { address asset; uint256 amount; uint256 userEModeCategoryId; }",
  "struct Exit { address asset; uint256 amount; }",
  "function enter(Enter data)",
  "function exit(Exit data)",
]);
const withdrawManagerAbi = parseAbi([
  "struct WithdrawRequestInfo { uint256 shares; uint256 endWithdrawWindowTimestamp; bool canWithdraw; uint256 withdrawWindowInSeconds; }",
  "function requestShares(uint256 shares)",
  "function releaseFunds(uint256 timestamp, uint256 sharesToRelease)",
  "function requestInfo(address account) view returns (WithdrawRequestInfo)",
  "function getSharesToRelease() view returns (uint256)",
  "function getWithdrawWindow() view returns (uint256)",
  "function getRequestFee() view returns (uint256)",
  "function updateRequestFee(uint256 fee)",
  "error WithdrawManagerInvalidTimestamp(uint256 timestamp)",
  "error WithdrawManagerZeroShares()",
]);

const usdc = (amount: string) => parseUnits(amount, 6);
// Fees are WAD: 1e18 is 100%.
const ONE_PERCENT = parseUnits("0.01", 18);
const WAD = 10n ** 18n;

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);
const alpha = await viem.getWalletClient(ALPHA);
const depositorA = await viem.getWalletClient(DEPOSITOR_A);
const depositorB = await viem.getWalletClient(DEPOSITOR_B);
const requestFeeManager = await viem.getWalletClient(REQUEST_FEE_MANAGER);

describe("S9 Scheduled withdraw from a USDC vault on Aave V3", () => {
  let vault: Address, accessManager: Address, withdrawManager: Address;
  let lockEnd: bigint, requestFee: bigint;

  const read = {
    shares: (account: Address) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account] }),
    usdc: (account: Address) => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    toShares: (assets: bigint) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToShares", args: [assets] }),
    toAssets: (shares: bigint) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [shares] }),
    request: (account: Address) => publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "requestInfo", args: [account] }),
    sharesToRelease: () => publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getSharesToRelease" }),
    now: async () => (await publicClient.getBlock()).timestamp,
  };
  const exitAave = async (amount: bigint) => {
    const data = encodeFunctionData({ abi: aaveV3SupplyFuseAbi, functionName: "exit", args: [{ asset: USDC, amount }] });
    await publicClient.waitForTransactionReceipt({ hash: await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[{ fuse: AAVE_V3_SUPPLY_FUSE, data }]] }) });
  };
  // The Alpha releases shares for every request made before the timestamp, which must be in the past.
  // The UI passes the request's own timestamp plus 1 s, so it waits 1 s first.
  const release = async (account: Address, shares: bigint) => {
    const { endWithdrawWindowTimestamp, withdrawWindowInSeconds } = await read.request(account);
    const requestTimestamp = endWithdrawWindowTimestamp - withdrawWindowInSeconds;
    await networkHelpers.time.increase(1);
    await publicClient.waitForTransactionReceipt({ hash: await alpha.writeContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "releaseFunds", args: [requestTimestamp + 1n, shares] }) });
  };

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas for its USDC transfers.
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(USDC_WHALE);
    for (const depositor of [DEPOSITOR_A, DEPOSITOR_B] as const) {
      await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [depositor, usdc("1000")] }) });
    }
  });

  it("01 clones a vault, reads its Withdraw Manager and grants its roles, as in S1", async () => {
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Story USDC", "sUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    vault = created.args.plasmaVault;
    accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });
    // The slot holds the address left-padded to 32 bytes, so its last 20 bytes are the address.
    const slot = await publicClient.getStorageAt({ address: vault, slot: WITHDRAW_MANAGER_SLOT });
    assert.ok(slot, "the Withdraw Manager slot is empty");
    withdrawManager = getAddress(slice(slot, 12));
    // On the access manager: the Owner grants the Atomist role, which unlocks role grants and convertToPublicVault on the vault.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] }) });
    // On the access manager: Fuse Manager unlocks addFuses and grantMarketSubstrates on the vault.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [FUSE_MANAGER_ROLE, FUSE_MANAGER, 0] }) });
    // On the access manager: Alpha unlocks execute on the vault and releaseFunds on the Withdraw Manager.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ALPHA_ROLE, ALPHA, 0] }) });

    assert.notEqual(vault, zeroAddress);
    assert.notEqual(withdrawManager, zeroAddress);
  });

  it("02 installs Aave V3 and opens deposits to everyone, as in S1", async () => {
    const usdcSubstrate = pad(USDC, { size: 32 });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addFuses", args: [[AAVE_V3_SUPPLY_FUSE]] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addBalanceFuse", args: [AAVE_V3_MARKET, AAVE_V3_BALANCE_FUSE] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addBalanceFuse", args: [ERC20_VAULT_BALANCE_MARKET, ERC20_BALANCE_FUSE] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "grantMarketSubstrates", args: [AAVE_V3_MARKET, [usdcSubstrate]] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "grantMarketSubstrates", args: [ERC20_VAULT_BALANCE_MARKET, [usdcSubstrate]] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "updateDependencyBalanceGraphs", args: [[AAVE_V3_MARKET], [[ERC20_VAULT_BALANCE_MARKET]]] }) });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "convertToPublicVault" }) });
  });

  it("03 A and B deposit 1000 USDC each and the Alpha supplies all idle funds to Aave V3", async () => {
    // S3 explains the deposit, S7 the Alpha's execute call.
    for (const depositor of [depositorA, depositorB]) {
      await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, usdc("1000")] }) });
      await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [usdc("1000"), depositor.account.address] }) });
    }
    const idle = await read.usdc(vault);
    const data = encodeFunctionData({ abi: aaveV3SupplyFuseAbi, functionName: "enter", args: [{ asset: USDC, amount: idle, userEModeCategoryId: 0n }] });
    await publicClient.waitForTransactionReceipt({ hash: await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[{ fuse: AAVE_V3_SUPPLY_FUSE, data }]] }) });

    assert.equal(idle, usdc("2000"));
    assert.equal(await read.usdc(vault), 0n);
  });

  it("04 a plain withdraw reverts: nothing is idle and no instant-withdrawal fuse can unwind Aave", async () => {
    // This is why the scheduled path exists. The UI picks it when the amount is above max instant (S8).
    await assert.rejects(
      depositorA.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [usdc("100"), DEPOSITOR_A, DEPOSITOR_A] }),
      /transfer amount exceeds balance/,
    );
  });

  it("05 reads the Scheduled form: withdraw window, lock end, and the request fee once the Atomist sets one", async () => {
    const window = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getWithdrawWindow" });
    // "… withdraw it by": the UI adds the window to its clock. Here the clock is the chain's.
    lockEnd = (await read.now()) + window;
    // On the access manager: role 901 unlocks updateRequestFee on the Withdraw Manager. The Atomist administers it.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [WITHDRAW_MANAGER_REQUEST_FEE_ROLE, REQUEST_FEE_MANAGER, 0] }) });
    await publicClient.waitForTransactionReceipt({ hash: await requestFeeManager.writeContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "updateRequestFee", args: [ONE_PERCENT] }) });
    // "Off-boarding (x%)": the request fee, shown as amount * fee / 1e18.
    requestFee = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getRequestFee" });

    assert.equal(window, 86400n);
    assert.ok(lockEnd > window);
    assert.equal(requestFee, ONE_PERCENT);
    assert.equal((usdc("400") * requestFee) / WAD, usdc("4"));
  });

  it("06 A requests 400 USDC: the fee is taken up front, the shares stay with A, nothing is redeemable yet", async () => {
    const shares = await read.toShares(usdc("400"));
    const fee = (shares * requestFee) / WAD;
    const balanceBefore = await read.shares(DEPOSITOR_A);
    await publicClient.waitForTransactionReceipt({ hash: await depositorA.writeContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "requestShares", args: [shares] }) });
    const request = await read.request(DEPOSITOR_A);

    // The request records the shares minus the fee. The fee shares move to the Withdraw Manager.
    assert.equal(request.shares, shares - fee);
    // A request does not lock shares: A still holds every share but the fee.
    assert.equal(await read.shares(DEPOSITOR_A), balanceBefore - fee);
    assert.equal(request.endWithdrawWindowTimestamp - request.withdrawWindowInSeconds, await read.now());
    assert.ok(request.endWithdrawWindowTimestamp >= lockEnd);
    assert.equal(request.canWithdraw, false);
  });

  it("07 the Alpha exits 400 USDC from Aave and releases A's request", async () => {
    const { shares } = await read.request(DEPOSITOR_A);
    await exitAave(usdc("400"));
    await release(DEPOSITOR_A, shares);

    assert.equal(await read.sharesToRelease(), shares);
    assert.equal((await read.request(DEPOSITOR_A)).canWithdraw, true);
  });

  it("08 A redeems from the request and receives the USDC", async () => {
    const { shares } = await read.request(DEPOSITOR_A);
    // "Requested amount": the request's shares in assets.
    const expected = await read.toAssets(shares);
    const usdcBefore = await read.usdc(DEPOSITOR_A);
    await publicClient.waitForTransactionReceipt({ hash: await depositorA.writeContract({ address: vault, abi: vaultAbi, functionName: "redeemFromRequest", args: [shares, DEPOSITOR_A, DEPOSITOR_A] }) });
    const received = (await read.usdc(DEPOSITOR_A)) - usdcBefore;

    // Management fee accrual pays slightly under convertToAssets (0.011% measured at 1%).
    assert.ok(received <= expected && received >= (expected * 9990n) / 10000n, `received ${received}, expected about ${expected}`);
    assert.equal((await read.request(DEPOSITOR_A)).shares, 0n);
    assert.equal(await read.sharesToRelease(), 0n);
  });

  it("09 B requests 500 USDC, the Alpha releases only 200, and B redeems what is available", async () => {
    await publicClient.waitForTransactionReceipt({ hash: await depositorB.writeContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "requestShares", args: [await read.toShares(usdc("500"))] }) });
    await exitAave(usdc("200"));
    await release(DEPOSITOR_B, await read.toShares(usdc("200")));

    const requested = (await read.request(DEPOSITOR_B)).shares;
    // "Available to redeem": the shares the release covers, capped by the request and B's balance.
    const balance = await read.shares(DEPOSITOR_B);
    const released = await read.sharesToRelease();
    const coverable = [requested, balance, released].reduce((a, b) => (a < b ? a : b));
    assert.ok(coverable > 0n && coverable < requested, `coverable ${coverable} of ${requested}`);

    const usdcBefore = await read.usdc(DEPOSITOR_B);
    await publicClient.waitForTransactionReceipt({ hash: await depositorB.writeContract({ address: vault, abi: vaultAbi, functionName: "redeemFromRequest", args: [coverable, DEPOSITOR_B, DEPOSITOR_B] }) });
    const received = (await read.usdc(DEPOSITOR_B)) - usdcBefore;

    assert.ok(received <= usdc("200") && received >= usdc("199.9"), `received ${received}`);
    // The rest of the request stays open until the Alpha releases more.
    assert.equal((await read.request(DEPOSITOR_B)).shares, requested - coverable);
  });

  it("10 B requests again inside the window: the new request replaces the old one and the fee paid is not refunded", async () => {
    // The UI warns before "Update Withdrawal": the remaining request is dropped, not added to.
    const before = await read.request(DEPOSITOR_B);
    const shares = await read.toShares(usdc("300"));
    const fee = (shares * requestFee) / WAD;
    const balanceBefore = await read.shares(DEPOSITOR_B);
    const feesHeldBefore = await read.shares(withdrawManager);
    await publicClient.waitForTransactionReceipt({ hash: await depositorB.writeContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "requestShares", args: [shares] }) });
    const after = await read.request(DEPOSITOR_B);

    assert.ok(before.shares > 0n && after.endWithdrawWindowTimestamp > before.endWithdrawWindowTimestamp);
    assert.equal(after.shares, shares - fee);
    // B pays the new fee in full and gets nothing of the first fee back: the Withdraw Manager keeps both.
    assert.equal(await read.shares(DEPOSITOR_B), balanceBefore - fee);
    assert.equal(await read.shares(withdrawManager), feesHeldBefore + fee);
    // The new request is newer than the last release, so it waits for its own.
    assert.equal(after.canWithdraw, false);
  });

  it("11 after the window ends, the request has expired and redeeming from it reverts", async () => {
    const { shares, endWithdrawWindowTimestamp } = await read.request(DEPOSITOR_B);
    // Released, so the only thing that stops B below is the window.
    await release(DEPOSITOR_B, shares);
    assert.equal((await read.request(DEPOSITOR_B)).canWithdraw, true);

    await networkHelpers.time.increaseTo(endWithdrawWindowTimestamp + 1n);

    assert.equal((await read.request(DEPOSITOR_B)).canWithdraw, false);
    await assert.rejects(
      depositorB.writeContract({ address: vault, abi: vaultAbi, functionName: "redeemFromRequest", args: [shares, DEPOSITOR_B, DEPOSITOR_B] }),
      /WithdrawManagerInvalidSharesToRelease/,
    );
  });
});
