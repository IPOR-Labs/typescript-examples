import { multicall } from "viem/actions";
import { fuseAbi } from "../abi/fuse.abi";
import { Address } from "viem";
import { PublicClient } from "viem";

interface Params {
  fuses: readonly Address[];
}

export async function getMarketIds(
  publicClient: PublicClient,
  params: Params,
) {
  const marketIdResults = await multicall(publicClient, {
    contracts: params.fuses.map((fuseAddress) => {
      return {
        address: fuseAddress,
        abi: fuseAbi,
        functionName: 'MARKET_ID',
      };
    }),
  });

  const fuseMarketIds = marketIdResults
    .map((result) => result.result)
    .filter((result) => result !== undefined);
  const uniqueMarketIds = Array.from(new Set(fuseMarketIds));

  return uniqueMarketIds;
}