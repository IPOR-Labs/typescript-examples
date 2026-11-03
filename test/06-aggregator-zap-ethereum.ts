// S6 Aggregator zap on Ethereum: swap WETH into a USDC vault in one zap transaction, from a recorded
// KyberSwap route and a recorded Velora route, then derive the numbers the deposit form previews.
// It stands alone: step 01 repeats S1's setup in short, without a market. The form values every deposit shares are in S3.
// Every step is a real transaction on an Ethereum fork, and a step depends on the steps above it.
// The routes are replayed from test/fixtures/, recorded at the fork block by scripts/record-zap-fixture.ts:
// a live aggregator quote goes stale against a pinned fork.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, parseEther, parseEventLogs, type Address, type Hex } from "viem";

// Ethereum addresses, from ipor-abi: mainnet/mainnet-ethereum-fusion/addresses.json at 9d1a7c7 (factory, zap)
// and README.md (USDC, WETH).
const FACTORY = "0xcd05909C4A1F8E501e4ED554cEF4Ed5E48D9b852";
const ZAP = "0x677251190C0cCcC6E7e71C385B3EA660Dfd89c00";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Role IDs from Roles.sol (ipor-fusion 4fdaf50).
const ATOMIST_ROLE = 100n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

// The fixture shape scripts/record-zap-fixture.ts writes. The route was built with the zap as sender and recipient.
type Fixture = {
  aggregator: string;
  block: number;
  pair: { tokenIn: Address; tokenOut: Address };
  amountIn: string;
  quotedOut: string;
  minOut: string;
  router: { target: Address; approvalProxy: Address };
  calldata: Hex;
};
const readFixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
const kyberswap = readFixture("kyberswap-ethereum.json");
const velora = readFixture("velora-ethereum.json");

// ABIs from ipor-abi (mainnet/mainnet-ethereum-fusion/abis; IporFusionFactoryImpl and IporFusionAccessManagerBase,
// PlasmaVaultBase, PriceOracleMiddleware). The zap ABI is the deployed ZapInData struct, without main's minSharesOut,
// as in ipor-webapp packages/fusion-sdk/src/abi/erc4626-zap-in-with-native-token.abi.ts at 220fe2a0a.
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
const vaultAbi = parseAbi([
  "function getAccessManagerAddress() view returns (address)",
  "function convertToPublicVault()",
  "function getPriceOracleMiddleware() view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
]);
const accessManagerAbi = parseAbi(["function grantRole(uint64 roleId, address account, uint32 executionDelay)"]);
const priceOracleAbi = parseAbi(["function getAssetPrice(address asset) view returns (uint256 assetPrice, uint256 decimals)"]);
const wethAbi = parseAbi(["function deposit() payable"]);
const zapAbi = parseAbi([
  "struct Call { address target; bytes data; uint256 nativeTokenAmount; }",
  "struct ZapInData { address vault; address receiver; uint256 minAmountToDeposit; address[] assetsToRefundToSender; Call[] calls; }",
  "function zapIn(ZapInData zapInData) payable returns (bytes[])",
  "function ZAP_IN_ALLOWANCE_CONTRACT() view returns (address)",
]);
const allowanceAbi = parseAbi(["function transferApprovedAssets(address asset, uint256 amount)"]);

const { viem } = await network.create("ethereum");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);

describe("S6 Aggregator zap of WETH into a USDC vault on Ethereum", () => {
  let vault: Address;
  const balanceOf = (token: Address, account: Address) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });

  // One zap transaction: the zap pulls the WETH, swaps it through the router and deposits the USDC for the depositor.
  const zapFromFixture = async (fixture: Fixture) => {
    const amount = BigInt(fixture.amountIn);
    const minAmountToDeposit = BigInt(fixture.minOut);
    const proxy = fixture.router.approvalProxy;
    // The depositor approves the zap's allowance contract, not the zap itself.
    const allowanceContract = await publicClient.readContract({ address: ZAP, abi: zapAbi, functionName: "ZAP_IN_ALLOWANCE_CONTRACT" });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: WETH, abi: erc20Abi, functionName: "approve", args: [allowanceContract, amount] }) });

    const wethBefore = await balanceOf(WETH, DEPOSITOR);
    const usdcBefore = await balanceOf(USDC, vault);
    const sharesBefore = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [DEPOSITOR] });
    const call = (target: Address, data: Hex) => ({ target, data, nativeTokenAmount: 0n });
    await publicClient.waitForTransactionReceipt({
      hash: await depositor.writeContract({
        address: ZAP,
        abi: zapAbi,
        functionName: "zapIn",
        args: [{
          vault,
          receiver: DEPOSITOR,
          // The zap reverts when it would deposit less: the aggregator's own minimum at 50 bps slippage.
          minAmountToDeposit,
          // WETH the router leaves unspent goes back to the depositor.
          assetsToRefundToSender: [WETH],
          calls: [
            call(allowanceContract, encodeFunctionData({ abi: allowanceAbi, functionName: "transferApprovedAssets", args: [WETH, amount] })),
            // Reset to 0 first, as the UI does for every token: USDT reverts on a non-zero to non-zero approve.
            call(WETH, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [proxy, 0n] })),
            call(WETH, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [proxy, amount] })),
            call(fixture.router.target, fixture.calldata),
            call(USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, maxUint256] })),
          ],
        }],
      }),
    });

    const youDeposit = wethBefore - (await balanceOf(WETH, DEPOSITOR));
    const youReceive = (await balanceOf(USDC, vault)) - usdcBefore;
    const shares = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [DEPOSITOR] })) - sharesBefore;
    // Assert against the minimum, never the quote: the route may pay anything between the two.
    assert.ok(youReceive >= minAmountToDeposit, `${fixture.aggregator}: vault received ${youReceive} USDC units, minimum ${minAmountToDeposit}`);
    assert.ok(shares > 0n, `${fixture.aggregator}: no shares minted`);
    return { youDeposit, youReceive };
  };

  // The UI shows these numbers before the transaction, from a simulation of the zap. This story skips simulation,
  // so it computes them from the balance changes of the real transaction.
  const previewValues = async ({ youDeposit, youReceive }: { youDeposit: bigint; youReceive: bigint }) => {
    // Rate: USDC per 1 WETH, in USDC units (6 decimals).
    const rate = (youReceive * 10n ** 18n) / youDeposit;
    // Both sides are valued with the vault's own oracle, never with aggregator-reported USD figures. Prices scale to 18 decimals.
    const oracle = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getPriceOracleMiddleware" });
    const usd18 = async (token: Address, amount: bigint, decimals: bigint) => {
      const [price, priceDecimals] = await publicClient.readContract({ address: oracle, abi: priceOracleAbi, functionName: "getAssetPrice", args: [token] });
      return (amount * price * 10n ** 18n) / 10n ** priceDecimals / 10n ** decimals;
    };
    const usdIn = await usd18(WETH, youDeposit, 18n);
    const usdOut = await usd18(USDC, youReceive, 6n);
    // Price impact in percent with two decimals, as computePriceImpact in ipor-webapp src/fusion/deposit/aggregator-zap-in/aggregator-zap-in.utils.ts at eb6664e2e: (usdIn - usdOut) / usdIn * 100.
    const priceImpact = Number(((usdIn - usdOut) * 10_000n) / usdIn) / 100;

    assert.ok(youDeposit > 0n, `You deposit ${youDeposit}`);
    assert.ok(rate > 0n, `rate ${rate}`);
    assert.ok(usdIn > 0n && usdOut > 0n, `usdIn ${usdIn}, usdOut ${usdOut}`);
    assert.ok(priceImpact < 10, `price impact ${priceImpact}%`);
  };

  it("01 clones a USDC vault, grants the Atomist and opens deposits to everyone, as in S1", async () => {
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Story USDC", "sUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    vault = created.args.plasmaVault;
    const accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });
    // On the access manager: the Owner grants the Atomist role, which unlocks convertToPublicVault and the role grants that follow.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] }) });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "convertToPublicVault" }) });

    assert.equal(kyberswap.block, velora.block, "both Ethereum fixtures are quoted at the fork block");
  });

  it("02 the depositor wraps 0.2 ETH into WETH, the token both zaps spend", async () => {
    const before = await balanceOf(WETH, DEPOSITOR);
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: WETH, abi: wethAbi, functionName: "deposit", value: parseEther("0.2") }) });

    assert.equal((await balanceOf(WETH, DEPOSITOR)) - before, BigInt(kyberswap.amountIn) + BigInt(velora.amountIn));
  });

  it("03 zaps 0.1 WETH into the vault through the recorded KyberSwap route", async () => {
    await previewValues(await zapFromFixture(kyberswap));
  });

  it("04 zaps 0.1 WETH into the vault through the recorded Velora route", async () => {
    await previewValues(await zapFromFixture(velora));
  });
});
