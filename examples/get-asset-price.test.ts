import { it, beforeEach, afterEach, expect, describe } from 'vitest';
import { mainnet } from 'viem/chains';
import { createPublicTestClient } from '../lib/clients';
import { createFork } from '../lib/create-fork';
import { getAssetPrice } from './get-asset-price';
import { getPriceOracleMiddleware } from './get-price-oracle-middleware';
import { formatUnits } from 'viem';

const BLOCK_NUMBER = 22525475n;

const server = createFork(mainnet, BLOCK_NUMBER);

beforeEach(async () => {
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('getAssetPrice', () => {
  it('should get price of the asset', async () => {
    const plasmaVault = '0x43a32d4f6c582f281c52393f8f9e5ace1d4a1e68';
    const publicClient = createPublicTestClient(server, mainnet);
    const PT_sUSDE_31JUL2025 = '0x3b3fb9c57858ef816833dc91565efcd85d96f634';

    const priceOracleMiddleware = await getPriceOracleMiddleware(publicClient, {
      plasmaVault,
    });

    const assetPrice = await getAssetPrice(publicClient, {
      priceOracleMiddleware,
      asset: PT_sUSDE_31JUL2025,
    });

    expect(assetPrice).toStrictEqual([
      984463940000000000n,
      18n,
    ]);

    const [price, decimals] = assetPrice;

    expect(formatUnits(price, Number(decimals))).toBe('0.98446394');
  }, 30_000);
});