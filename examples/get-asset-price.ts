import { readContract } from "viem/actions";
import { Address } from "viem";
import { PublicClient } from "viem";
import { priceOracleMiddlewareAbi } from "../abi/price-oracle-middleware.abi";

interface Params {
  priceOracleMiddleware: Address;
  asset: Address;
}

export async function getAssetPrice(
  publicClient: PublicClient,
  params: Params,
) {
  const assetPrice = await readContract(publicClient, {
    address: params.priceOracleMiddleware,
    abi: priceOracleMiddlewareAbi,
    functionName: 'getAssetPrice',
    args: [params.asset],
  });

  return assetPrice;
}