// S8 Instant withdraw and redeem: withdraw from idle funds, see the shortfall revert, then add an
// instant-withdrawal fuse that unwinds Aave V3 on demand, and see how the withdraw fee behaves.
// It follows S1: steps 01 and 02 repeat S1's setup in short, then a depositor funds the vault.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
// The UI finds "Max instant withdraw" by a binary search of simulated withdrawals. Steps 04 and 08
// show the replacements: a formula without instant-withdrawal fuses, a real redeem in a snapshot with them.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, parseEther, parseEventLogs, parseUnits, pad, slice, isAddressEqual, zeroAddress, zeroHash, type Address } from "viem";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory, Aave V3 fuses),
// mainnet/addresses.json at e228075 (BalanceFuseErc20) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const AAVE_V3_SUPPLY_FUSE = "0x26fD6EF391E98C78CfCA27e00c3d15be4D941625";
const AAVE_V3_BALANCE_FUSE = "0x952573Ec1B6895a88a95CA523097083d4da4D8e5";
const ERC20_BALANCE_FUSE = "0x9ba147FC382DBf4D73512A45370ba0B70c25F6aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// An EOA that holds enough USDC on Base at the fork block to fund the depositor.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";
// The vault keeps its Withdraw Manager address in this storage slot and has no getter for it
// (WITHDRAW_MANAGER in contracts/libraries/PlasmaVaultStorageLib.sol:722, ipor-fusion 004d054).
const WITHDRAW_MANAGER_SLOT = "0x465d2ff0062318fe6f4c7e9ac78cfcd70bc86a1d992722875ef83a9770513100";

// Market IDs from IporFusionMarkets.sol (ipor-fusion 004d054) and role IDs from Roles.sol (ipor-fusion 4fdaf50).
const AAVE_V3_MARKET = 1n;
const ERC20_VAULT_BALANCE_MARKET = 7n;
const ATOMIST_ROLE = 100n;
const ALPHA_ROLE = 200n;
const FUSE_MANAGER_ROLE = 300n;
const CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE = 900n;
const WITHDRAW_MANAGER_WITHDRAW_FEE_ROLE = 902n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FUSE_MANAGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ALPHA = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

// ABIs from ipor-abi (mainnet/mainnet-base-fusion/abis; IporFusionFactoryImpl, IporFusionAccessManagerBase,
// IporFusionPlasmaVaultCoreBase, IporFusionWithdrawManagerBase and SupplyFuseAaveV3 at 55b2d9e, PlasmaVaultBase at b942366):
// IporFusionFactory, PlasmaVault (with PlasmaVaultGovernance), IporFusionAccessManager, WithdrawManager and the Aave V3 supply fuse.
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
const vaultAbi = parseAbi([
  "struct FuseAction { address fuse; bytes data; }",
  "struct InstantWithdrawalFusesParamsStruct { address fuse; bytes32[] params; }",
  "function getAccessManagerAddress() view returns (address)",
  "function addFuses(address[] fuses)",
  "function addBalanceFuse(uint256 marketId, address fuse)",
  "function grantMarketSubstrates(uint256 marketId, bytes32[] substrates)",
  "function updateDependencyBalanceGraphs(uint256[] marketIds, uint256[][] dependencies)",
  "function convertToPublicVault()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function execute(FuseAction[] calls)",
  "function configureInstantWithdrawalFuses(InstantWithdrawalFusesParamsStruct[] fuses)",
  "function getInstantWithdrawalFuses() view returns (address[])",
  "function getInstantWithdrawalFusesParams(address fuse, uint256 index) view returns (bytes32[])",
  "function totalAssetsInMarket(uint256 marketId) view returns (uint256)",
  "error AccessManagedUnauthorized(address caller)",
]);
const accessManagerAbi = parseAbi(["function grantRole(uint64 roleId, address account, uint32 executionDelay)"]);
const withdrawManagerAbi = parseAbi([
  "function getPlasmaVaultAddress() view returns (address)",
  "function getSharesToRelease() view returns (uint256)",
  "function getWithdrawFee() view returns (uint256)",
  "function updateWithdrawFee(uint256 fee)",
  "error WithdrawManagerInvalidFee(uint256 fee)",
]);
const aaveV3SupplyFuseAbi = parseAbi([
  "struct Enter { address asset; uint256 amount; uint256 userEModeCategoryId; }",
  "function enter(Enter data)",
]);

const usdc = (amount: string) => parseUnits(amount, 6);

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);
const alpha = await viem.getWalletClient(ALPHA);
const depositor = await viem.getWalletClient(DEPOSITOR);

describe("S8 Instant withdraw and redeem on a USDC vault with Aave V3", () => {
  let vault: Address, accessManager: Address, withdrawManager: Address, maxInstant: bigint;
  const idle = () => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
  const inAave = () => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssetsInMarket", args: [AAVE_V3_MARKET] });
  const usdcOf = (account: Address) => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  const sharesOf = (account: Address) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account] });
  const toAssets = (shares: bigint) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [shares] });
  const toShares = (assets: bigint) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToShares", args: [assets] });
  const withdraw = async (assets: bigint) =>
    publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [assets, DEPOSITOR, DEPOSITOR] }) });
  const redeem = async (shares: bigint) =>
    publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "redeem", args: [shares, DEPOSITOR, DEPOSITOR] }) });

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas for its USDC transfer.
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(USDC_WHALE);
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [DEPOSITOR, usdc("1000")] }) });
  });

  it("01 clones a vault, grants its roles as in S1, and reads the Withdraw Manager from storage", async () => {
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Story USDC", "sUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    vault = created.args.plasmaVault;
    accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });
    // On the access manager: the Owner grants the Atomist role, which unlocks role grants and convertToPublicVault on the vault.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] }) });
    // On the access manager: Fuse Manager unlocks addFuses and grantMarketSubstrates on the vault.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [FUSE_MANAGER_ROLE, FUSE_MANAGER, 0] }) });
    // On the access manager: Alpha unlocks execute on the vault.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ALPHA_ROLE, ALPHA, 0] }) });
    // The event omits the Withdraw Manager and clone's return value needs a simulation, so read the slot.
    // The slot holds the address left-padded to 32 bytes.
    const word = await publicClient.getStorageAt({ address: vault, slot: WITHDRAW_MANAGER_SLOT });
    assert.ok(word && word !== zeroHash, "the vault has no Withdraw Manager");
    withdrawManager = getAddress(slice(word, 12));

    assert.notEqual(vault, zeroAddress);
    assert.ok(isAddressEqual(await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getPlasmaVaultAddress" }), vault));
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

  it("03 a depositor deposits 1000 USDC and the Alpha supplies 600 of it to Aave V3", async () => {
    // S3 explains the deposit, S7 the Alpha's execute call.
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, usdc("1000")] }) });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [usdc("1000"), DEPOSITOR] }) });
    const data = encodeFunctionData({ abi: aaveV3SupplyFuseAbi, functionName: "enter", args: [{ asset: USDC, amount: usdc("600"), userEModeCategoryId: 0n }] });
    await publicClient.waitForTransactionReceipt({ hash: await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[{ fuse: AAVE_V3_SUPPLY_FUSE, data }]] }) });

    assert.equal(await idle(), usdc("400"));
  });

  it("04 computes Max instant withdraw from idle funds, with no instant-withdrawal fuses", async () => {
    // Without instant-withdrawal fuses, only idle USDC can pay, less what released requests reserve (S9).
    const balanceInAssets = await toAssets(await sharesOf(DEPOSITOR));
    const sharesToRelease = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getSharesToRelease" });
    const freeIdle = (await idle()) - (await toAssets(sharesToRelease));
    maxInstant = balanceInAssets < freeIdle ? balanceInAssets : freeIdle;

    assert.ok(balanceInAssets >= usdc("1000") - 1n, `balance in assets: ${balanceInAssets}`);
    assert.equal(sharesToRelease, 0n);
    assert.equal(maxInstant, usdc("400"));
  });

  it("05 a withdraw of one unit more than Max instant reverts in the USDC transfer", async () => {
    // maxWithdraw passes (it ignores liquidity), the vault has no fuse to unwind Aave, so USDC's transfer fails.
    await assert.rejects(withdraw(maxInstant + 1n), /ERC20: transfer amount exceeds balance/);
  });

  it("06 the depositor withdraws exactly Max instant", async () => {
    const usdcBefore = await usdcOf(DEPOSITOR);
    await withdraw(maxInstant);

    assert.equal((await usdcOf(DEPOSITOR)) - usdcBefore, maxInstant);
    assert.equal(await idle(), 0n);
  });

  it("07 the Atomist grants role 900 and configures the Aave V3 supply fuse as an instant-withdrawal fuse", async () => {
    // On the access manager: role 900 unlocks configureInstantWithdrawalFuses on the vault. No address holds it after clone.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE, ATOMIST, 0] }) });
    // The fuse's instantWithdraw takes [amount, asset]. params[0] is a placeholder: the vault fills in the amount at withdraw time.
    const params = [zeroHash, pad(USDC, { size: 32 })];
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "configureInstantWithdrawalFuses", args: [[{ fuse: AAVE_V3_SUPPLY_FUSE, params }]] }) });

    const fuses = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getInstantWithdrawalFuses" });
    assert.equal(fuses.length, 1);
    assert.ok(fuses[0] && isAddressEqual(fuses[0], AAVE_V3_SUPPLY_FUSE));
    // Params are stored per fuse and per position in the list. The chain returns hex in lower case.
    const stored = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getInstantWithdrawalFusesParams", args: [AAVE_V3_SUPPLY_FUSE, 0n] });
    assert.deepEqual(stored, params.map((param) => param.toLowerCase()));
  });

  it("08 reads Max instant withdraw by a real redeem of the whole balance in a snapshot, then reverts it", async () => {
    // With fuses, what the vault can pay depends on the market, so the formula no longer holds: try it for real and undo.
    const shares = await sharesOf(DEPOSITOR);
    const aaveBefore = await inAave();
    const usdcBefore = await usdcOf(DEPOSITOR);
    const snapshot = await networkHelpers.takeSnapshot();
    await redeem(shares);
    maxInstant = (await usdcOf(DEPOSITOR)) - usdcBefore;
    await snapshot.restore();

    assert.ok(maxInstant > usdc("599") && maxInstant <= usdc("601"), `max instant: ${maxInstant}`);
    // The snapshot left no trace: same shares, same USDC, same market balance.
    assert.equal(await sharesOf(DEPOSITOR), shares);
    assert.equal(await usdcOf(DEPOSITOR), usdcBefore);
    assert.equal(await inAave(), aaveBefore);
  });

  it("09 a withdraw above idle now succeeds and the fuse unwinds Aave V3", async () => {
    const aaveBefore = await inAave();
    const usdcBefore = await usdcOf(DEPOSITOR);
    assert.ok((await idle()) < usdc("200"));
    await withdraw(usdc("200"));

    assert.equal((await usdcOf(DEPOSITOR)) - usdcBefore, usdc("200"));
    assert.ok((await inAave()) <= aaveBefore - usdc("200"), `Aave V3: ${aaveBefore} -> ${await inAave()}`);
  });

  it("10 the Atomist grants role 902 and sets a 1% withdraw fee", async () => {
    // On the access manager: role 902 unlocks updateWithdrawFee on the Withdraw Manager. The fee has 18 decimals: 1e16 is 1%.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [WITHDRAW_MANAGER_WITHDRAW_FEE_ROLE, ATOMIST, 0] }) });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "updateWithdrawFee", args: [parseEther("0.01")] }) });

    assert.equal(await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getWithdrawFee" }), parseEther("0.01"));
  });

  it("11 withdraw(100 USDC) pays 100 USDC and burns about 101 USDC of shares", async () => {
    // The UI's "Payout" shows 100 - 1% = 99 USDC here, and is wrong: withdraw pays the full amount and burns the fee as extra shares.
    const sharesFor100 = await toShares(usdc("100"));
    const sharesBefore = await sharesOf(DEPOSITOR);
    const usdcBefore = await usdcOf(DEPOSITOR);
    await withdraw(usdc("100"));
    const burned = sharesBefore - (await sharesOf(DEPOSITOR));

    assert.equal((await usdcOf(DEPOSITOR)) - usdcBefore, usdc("100"));
    assert.ok(burned > sharesFor100, `burned ${burned}, 100 USDC is ${sharesFor100} shares`);
    // The fee is 1% of the shares for 100 USDC, so the burned shares are worth about 101 USDC at the price before the call.
    assert.ok(burned * 10000n >= sharesFor100 * 10099n && burned * 10000n <= sharesFor100 * 10101n, `burned ${burned}, 100 USDC is ${sharesFor100} shares`);
  });

  it("12 redeem of the whole balance pays assets - assets * fee / 1e18, as the UI's Payout says", async () => {
    const fee = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getWithdrawFee" });
    const shares = await sharesOf(DEPOSITOR);
    const assets = await toAssets(shares);
    const payout = assets - (assets * fee) / 10n ** 18n;
    const usdcBefore = await usdcOf(DEPOSITOR);
    await redeem(shares);
    const received = (await usdcOf(DEPOSITOR)) - usdcBefore;

    // The formula is right for redeem, but not exact here. Step 11 burned about 1 USDC of fee shares, which raised the
    // share price, and redeem first mints the DAO's performance fee (10% in fee package 0) on that rise. So the payout
    // lands below the formula by up to 10% of the burned fee: 0.1 USDC.
    assert.ok(received <= payout && payout - received <= usdc("0.1"), `received ${received}, Payout formula ${payout}`);
    assert.equal(await sharesOf(DEPOSITOR), 0n);
  });
});
