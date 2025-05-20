import { Address, PublicClient } from "viem";
import { multicall } from "viem/actions";
import { plasmaVaultAbi } from "../abi/plasma-vault.abi";

interface Params {
  plasmaVault: Address;
  marketIds: bigint[];
}

export const getTotalAssets = async (
  publicClient: PublicClient, 
  params: Params,
) => {
  const results = await multicall(publicClient, {
    contracts: [
      /**
       * @dev Call updateMarketsBalances before
       * to get totalAssets with accrued interest in the markets
       */
      {
        address: params.plasmaVault,
        abi: plasmaVaultAbi,
        functionName: 'updateMarketsBalances',
        args: [params.marketIds],
      },
      {
        address: params.plasmaVault,
        abi: plasmaVaultAbi,
        functionName: 'totalAssets',
      },
    ],
  });

  return results[1].result;
};
