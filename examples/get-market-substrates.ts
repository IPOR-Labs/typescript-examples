import { readContract } from "viem/actions";
import { Address } from "viem";
import { PublicClient } from "viem";
import { plasmaVaultAbi } from "../abi/plasma-vault.abi";

interface Params {
  plasmaVault: Address;
  marketId: bigint;
}

export async function getMarketSubstrates(
  publicClient: PublicClient,
  params: Params,
) {
  const marketSubstrates = await readContract(publicClient, {
    address: params.plasmaVault,
    abi: plasmaVaultAbi,
    functionName: 'getMarketSubstrates',
    args: [params.marketId],
  });

  return marketSubstrates;
}