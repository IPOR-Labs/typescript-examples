import { readContract } from "viem/actions";
import { Address } from "viem";
import { PublicClient } from "viem";
import { plasmaVaultAbi } from "../abi/plasma-vault.abi";

interface Params {
  plasmaVault: Address;
}

export async function getPriceOracleMiddleware(
  publicClient: PublicClient,
  params: Params,
) {
  const priceOracleMiddleware = await readContract(publicClient, {
    address: params.plasmaVault,
    abi: plasmaVaultAbi,
    functionName: 'getPriceOracleMiddleware',
  });

  return priceOracleMiddleware;
}