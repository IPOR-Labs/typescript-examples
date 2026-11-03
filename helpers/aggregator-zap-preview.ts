import assert from "node:assert/strict";
import type { Address, PublicClient } from "viem";
import { priceOracleAbi } from "../abis/priceOracle.abi.ts";
import { vaultAbi } from "../abis/vault.abi.ts";

// Rates and prices are scaled to 18 decimals, as in a client.
const WAD_DECIMALS = 18;

// A client shows these numbers before the transaction, from a simulation of the zap. The S6 stories skip simulation,
// so they compute them from the balance changes of the real transaction.
export const previewValues = async ({
  publicClient,
  vault,
  weth,
  usdc,
  youDeposit,
  youReceive,
}: {
  publicClient: PublicClient;
  vault: Address;
  weth: Address;
  usdc: Address;
  youDeposit: bigint;
  youReceive: bigint;
}) => {
  // Rate: USDC per 1 WETH, in USDC units (6 decimals).
  const rate = (youReceive * 10n ** BigInt(WAD_DECIMALS)) / youDeposit;
  // Both sides are valued with the vault's own oracle, never with aggregator-reported USD figures. Prices scale to 18 decimals.
  const oracle = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "getPriceOracleMiddleware",
  });
  const usd18 = async (token: Address, amount: bigint, decimals: bigint) => {
    const [price, priceDecimals] = await publicClient.readContract({
      address: oracle,
      abi: priceOracleAbi,
      functionName: "getAssetPrice",
      args: [token],
    });
    return (amount * price * 10n ** BigInt(WAD_DECIMALS)) / 10n ** priceDecimals / 10n ** decimals;
  };
  const usdIn = await usd18(weth, youDeposit, 18n);
  const usdOut = await usd18(usdc, youReceive, 6n);
  // Price impact in percent with two decimals, as computePriceImpact in ipor-webapp src/fusion/deposit/aggregator-zap-in/aggregator-zap-in.utils.ts at eb6664e2e: (usdIn - usdOut) / usdIn * 100.
  const priceImpact = Number(((usdIn - usdOut) * 10_000n) / usdIn) / 100;

  assert.ok(youDeposit > 0n, `You deposit ${youDeposit}`);
  assert.ok(rate > 0n, `rate ${rate}`);
  assert.ok(usdIn > 0n && usdOut > 0n, `usdIn ${usdIn}, usdOut ${usdOut}`);
  assert.ok(priceImpact < 10, `price impact ${priceImpact}%`);
};
