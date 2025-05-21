import { readContract } from "viem/actions";
import { Address, erc20Abi, erc4626Abi } from "viem";
import { PublicClient } from "viem";
import { getPriceOracleMiddleware } from "./get-price-oracle-middleware";
import { getAssetPrice } from "./get-asset-price";
import { getTotalAssets } from "./get-total-assets";
import { getMarketIds } from "./get-market-ids";
import { getFuses } from "./get-fuses";

interface Params {
  plasmaVault: Address;
}

export async function getTvl(
  publicClient: PublicClient,
  params: Params,
) {
  const asset = await readContract(publicClient, {
    address: params.plasmaVault,
    abi: erc4626Abi,
    functionName: 'asset',
  });

  const priceOracleMiddleware = await getPriceOracleMiddleware(publicClient, {
    plasmaVault: params.plasmaVault,
  });

  const [assetPrice, assetPriceDecimals] = await getAssetPrice(publicClient, {
    priceOracleMiddleware,
    asset,
  });

  const fuses = await getFuses(publicClient, {
    plasmaVault: params.plasmaVault,
  });

  const marketIds = await getMarketIds(publicClient, {
    fuses,
  });

  const totalAssets = await getTotalAssets(publicClient, {
    plasmaVault: params.plasmaVault,
    marketIds,
  });

  const assetDecimals = await readContract(publicClient, {
    address: asset,
    abi: erc20Abi,
    functionName: 'decimals',
  });

  const tvl = totalAssets * assetPrice / (10n ** assetPriceDecimals);

  return [tvl, assetDecimals] as const;
}