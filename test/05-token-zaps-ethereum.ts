// S5 Token zaps: deposit ETH, wstETH and USDC into vaults whose asset is another token, through the
// deployed zap contract ERC4626ZapInWithNativeToken. The zap runs the calls it is given (wrap, stake,
// unwrap, mint) and deposits the resulting vault asset in the same transaction.
// The vaults are set up as in S1, without a market: the zapped assets stay idle in the vault.
// The form values shared by every deposit method (balance, Max, public, paused, maxDeposit, withdraw note)
// are read as in S3. This story adds the values specific to a zap: the expected output, the slippage minimum
// passed as minAmountToDeposit, the approval spender and the native token's USD price.
// Every step is a real transaction on an Ethereum fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, parseEther, parseEventLogs, parseUnits, zeroAddress, type Address } from "viem";

// Ethereum addresses, from ipor-abi: mainnet/mainnet-ethereum-fusion/addresses.json at 9d1a7c7 (factory, zap)
// and ipor-webapp packages/fusion-sdk/src/markets/{weth,lido,reservoir}/*.addresses.ts at 556ca3f5a, 37b9619a2 and 37b9619a2
// (tokens, Reservoir PSM and CreditEnforcer).
const FACTORY = "0xcd05909C4A1F8E501e4ED554cEF4Ed5E48D9b852";
const ZAP = "0x677251190C0cCcC6E7e71C385B3EA660Dfd89c00";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const RUSD = "0x09D4214C03D01F49544C0448DBE3A27f768F2b34";
const RESERVOIR_PSM = "0x4809010926aec940b550D34a46A52739f996D75D";
const RESERVOIR_CREDIT_ENFORCER = "0x04716DB62C085D9e08050fcF6F7D775A03d07720";
// Chainlink ETH/USD on Ethereum, the feed the IPOR webapp reads for the native token price (ipor-webapp src/usdPrices/types.ts at a1416b1fd).
const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
// Morpho Blue holds wstETH and USDC on Ethereum: the story funds the depositor from it.
const WHALE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Role ID from Roles.sol (ipor-fusion 4fdaf50).
const ATOMIST_ROLE = 100n;

// Hardhat's default accounts.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

// The UI's default "Max slippage" is 0.5%. Rates and the slippage use 18 decimals, as in the UI.
const WAD = 10n ** 18n;
const SLIPPAGE = 5n * 10n ** 15n;
const slippageMinimum = (expected: bigint) => (expected * (WAD - SLIPPAGE)) / WAD;

// ABIs from ipor-abi (mainnet/mainnet-ethereum-fusion/abis) and the token contracts.
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
const vaultAbi = parseAbi([
  "function getAccessManagerAddress() view returns (address)",
  "function convertToPublicVault()",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);
const accessManagerAbi = parseAbi(["function grantRole(uint64 roleId, address account, uint32 executionDelay)"]);
// This is the deployed zap's ZapInData. The struct on ipor-fusion main has an extra minimum-shares field,
// and a call encoded with it reverts against the deployed zap.
const zapAbi = parseAbi([
  "struct Call { address target; bytes data; uint256 nativeTokenAmount; }",
  "struct ZapInData { address vault; address receiver; uint256 minAmountToDeposit; address[] assetsToRefundToSender; Call[] calls; }",
  "function zapIn(ZapInData zapInData) payable returns (bytes[])",
  "function ZAP_IN_ALLOWANCE_CONTRACT() view returns (address)",
  "error MinAmountToDepositIsZero()",
  "error InsufficientDepositAssetBalance()",
]);
const zapInAllowanceAbi = parseAbi(["function transferApprovedAssets(address asset, uint256 amount)"]);
const wethAbi = parseAbi(["function deposit() payable"]);
const stEthAbi = parseAbi(["function submit(address referral) payable returns (uint256)"]);
const wstEthAbi = parseAbi(["function unwrap(uint256 wstETHAmount) returns (uint256)", "function stEthPerToken() view returns (uint256)"]);
const creditEnforcerAbi = parseAbi(["function mintStablecoin(uint256 amount) returns (uint256)"]);
const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

const { viem, networkHelpers } = await network.create("ethereum");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);

describe("S5 Token zaps on Ethereum: Wrap ETH, Stake ETH, Unwrap wstETH, Mint rUSD", () => {
  let wethVault: Address, stEthVault: Address, rUsdVault: Address;
  const call = (target: Address, data: `0x${string}`, nativeTokenAmount = 0n) => ({ target, data, nativeTokenAmount });
  const totalAssets = (vault: Address) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" });
  const depositorAssets = async (vault: Address) =>
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [await publicClient.readContract({ address: vault, abi: erc20Abi, functionName: "balanceOf", args: [DEPOSITOR] })] });

  it("01 clones a WETH, an stETH and an rUSD vault and opens each to every depositor (see S1)", async () => {
    const clonePublicVault = async (asset: Address, name: string, symbol: string) => {
      const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: [name, symbol, asset, 0n, OWNER, 0n] });
      const [created] = parseEventLogs({ abi: factoryAbi, logs: (await publicClient.waitForTransactionReceipt({ hash })).logs, eventName: "FusionInstanceCreated" });
      assert.ok(created, "the receipt has no FusionInstanceCreated event");
      const vault = created.args.plasmaVault;
      const accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });
      // On the access manager: the Owner grants the Atomist role, which unlocks convertToPublicVault and the role grants that follow.
      await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] }) });
      await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "convertToPublicVault" }) });
      return vault;
    };
    wethVault = await clonePublicVault(WETH, "Story WETH", "sWETH");
    stEthVault = await clonePublicVault(STETH, "Story stETH", "sstETH");
    rUsdVault = await clonePublicVault(RUSD, "Story rUSD", "srUSD");

    for (const vault of [wethVault, stEthVault, rUsdVault]) assert.equal(await totalAssets(vault), 0n);
  });

  it("02 reads the native ETH price from Chainlink, as the UI prices an ETH amount", async () => {
    const [, answer] = await publicClient.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAbi, functionName: "latestRoundData" });
    const decimals = await publicClient.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAbi, functionName: "decimals" });
    assert.ok(answer > 0n, "the ETH/USD answer is not positive");
    // The UI scales the 8-decimal answer to 18 decimals, then prices the amount: 1 ETH in USD, 18 decimals.
    const ethUsd18 = answer * 10n ** (18n - BigInt(decimals));
    const oneEthUsd = (parseEther("1") * ethUsd18) / WAD;
    assert.ok(oneEthUsd > 0n);
  });

  it("03 Wrap ETH: the zap wraps ETH into WETH and deposits it into the WETH vault", async () => {
    const amount = parseEther("1");
    // Wrap ETH has a 1:1 rate and no slippage option: the minimum is the exact expected output.
    const expected = (amount * WAD) / WAD;
    const minimum = expected;
    // ETH is sent as the transaction value, so there is no approval. The zap deposits its whole WETH balance,
    // which must reach minAmountToDeposit.
    const hash = await depositor.writeContract({
      address: ZAP, abi: zapAbi, functionName: "zapIn", value: amount,
      args: [{ vault: wethVault, receiver: DEPOSITOR, minAmountToDeposit: minimum, assetsToRefundToSender: [], calls: [
        call(WETH, encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), amount),
        call(WETH, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [wethVault, maxUint256] })),
      ] }],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    assert.ok((await totalAssets(wethVault)) >= minimum);
    assert.ok((await depositorAssets(wethVault)) >= minimum);
  });

  it("04 Stake ETH: the zap stakes ETH with Lido and deposits the stETH into the stETH vault", async () => {
    const amount = parseEther("1");
    // Lido mints stETH 1:1 for ETH, but stETH balances round down by 1 to 2 wei: the minimum is 0.5% below.
    const expected = (amount * WAD) / WAD;
    const minimum = slippageMinimum(expected);
    const hash = await depositor.writeContract({
      address: ZAP, abi: zapAbi, functionName: "zapIn", value: amount,
      args: [{ vault: stEthVault, receiver: DEPOSITOR, minAmountToDeposit: minimum, assetsToRefundToSender: [], calls: [
        call(STETH, encodeFunctionData({ abi: stEthAbi, functionName: "submit", args: [zeroAddress] }), amount),
        call(STETH, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [stEthVault, maxUint256] })),
      ] }],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    assert.ok((await totalAssets(stEthVault)) >= minimum);
  });

  it("05 Unwrap wstETH: the depositor approves the zap's allowance contract, and the zap unwraps into the stETH vault", async () => {
    const amount = parseEther("1");
    // Unlocks the Morpho Blue address so the story can send its wstETH from it without its key.
    await networkHelpers.impersonateAccount(WHALE);
    // Gives the whale ETH to pay gas for its wstETH transfer.
    await networkHelpers.setBalance(WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(WHALE);
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: WSTETH, abi: erc20Abi, functionName: "transfer", args: [DEPOSITOR, amount] }) });

    // The approval spender is not the zap itself: it is the allowance contract the zap names.
    const allowanceContract = await publicClient.readContract({ address: ZAP, abi: zapAbi, functionName: "ZAP_IN_ALLOWANCE_CONTRACT" });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: WSTETH, abi: erc20Abi, functionName: "approve", args: [allowanceContract, amount] }) });
    assert.equal(await publicClient.readContract({ address: WSTETH, abi: erc20Abi, functionName: "allowance", args: [DEPOSITOR, allowanceContract] }), amount);

    // Expected output: amount * rate / 10^18, with the rate from stEthPerToken(). The minimum is 0.5% below.
    const rate = await publicClient.readContract({ address: WSTETH, abi: wstEthAbi, functionName: "stEthPerToken" });
    const expected = (amount * rate) / WAD;
    const minimum = slippageMinimum(expected);
    const before = await totalAssets(stEthVault);
    const hash = await depositor.writeContract({
      address: ZAP, abi: zapAbi, functionName: "zapIn",
      args: [{ vault: stEthVault, receiver: DEPOSITOR, minAmountToDeposit: minimum, assetsToRefundToSender: [], calls: [
        call(allowanceContract, encodeFunctionData({ abi: zapInAllowanceAbi, functionName: "transferApprovedAssets", args: [WSTETH, amount] })),
        call(WSTETH, encodeFunctionData({ abi: wstEthAbi, functionName: "unwrap", args: [amount] })),
        call(STETH, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [stEthVault, maxUint256] })),
      ] }],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    assert.ok((await totalAssets(stEthVault)) - before >= minimum);
  });

  it("06 Mint rUSD: the zap mints rUSD from USDC through Reservoir and deposits it into the rUSD vault", async () => {
    const amount = parseUnits("1000", 6);
    const whale = await viem.getWalletClient(WHALE);
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [DEPOSITOR, amount] }) });
    const allowanceContract = await publicClient.readContract({ address: ZAP, abi: zapAbi, functionName: "ZAP_IN_ALLOWANCE_CONTRACT" });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [allowanceContract, amount] }) });

    // Expected output: amount * 1e18 rate / 10^6 USDC decimals, so rUSD in 18 decimals. The minimum is 0.5% below.
    const expected = (amount * WAD) / 10n ** 6n;
    const minimum = slippageMinimum(expected);
    // The zap approves the PSM, pulls the USDC, and CreditEnforcer mints rUSD 1:1 through the PSM.
    const hash = await depositor.writeContract({
      address: ZAP, abi: zapAbi, functionName: "zapIn",
      args: [{ vault: rUsdVault, receiver: DEPOSITOR, minAmountToDeposit: minimum, assetsToRefundToSender: [], calls: [
        call(USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RESERVOIR_PSM, amount] })),
        call(allowanceContract, encodeFunctionData({ abi: zapInAllowanceAbi, functionName: "transferApprovedAssets", args: [USDC, amount] })),
        call(RESERVOIR_CREDIT_ENFORCER, encodeFunctionData({ abi: creditEnforcerAbi, functionName: "mintStablecoin", args: [amount] })),
        call(RUSD, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [rUsdVault, expected] })),
      ] }],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    assert.ok((await totalAssets(rUsdVault)) >= minimum);
  });
});
