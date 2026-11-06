/**
 * Create the tip token with the 3.69% HTS custom fee.
 *
 * Why a token with a custom fee instead of a splitter contract: an x402 `exact`
 * payment is ONE transfer to ONE payTo. The 96.31/3.69 split therefore has to
 * happen on the asset, not in the protocol. Hedera does this natively — a
 * fractional custom fee on the token routes 3.69% of every transfer to the agent
 * compute account, and the remaining 96.31% lands on the artist, atomically, in
 * the same transaction. Hedera's own "extra points" list calls this out.
 *
 *   node scripts/create-tip-token.ts
 *
 * Needs in .env (live mode):
 *   HEDERA_TREASURY_ACCOUNT_ID / _PRIVATE_KEY  — creates + pays for the token
 *   HEDERA_ARTIST_ACCOUNT_ID                  — receives 96.31%
 *   HEDERA_COMPUTE_ACCOUNT_ID                 — receives 3.69% (the fee collector)
 *
 * Prints the token id; put it in HEDERA_ASSET and restart payments.
 */
import { loadDotEnv } from '../src/config.ts';

loadDotEnv();

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing env ${k} — see .env.example / docs/RUNBOOK.md`);
    process.exit(1);
  }
  return v;
};

const treasuryId = need('HEDERA_TREASURY_ACCOUNT_ID');
const treasuryKey = need('HEDERA_TREASURY_PRIVATE_KEY');
const artistId = need('HEDERA_ARTIST_ACCOUNT_ID');
const computeId = need('HEDERA_COMPUTE_ACCOUNT_ID');
const agentBps = Number(process.env.SPLIT_AGENT_BPS ?? 369);
const decimals = Number(process.env.HEDERA_ASSET_DECIMALS ?? 6);

if (agentBps <= 0 || agentBps >= 10_000) {
  console.error(`SPLIT_AGENT_BPS must be between 1 and 9999, got ${agentBps}`);
  process.exit(1);
}

// Hedera fractional fees are expressed as numerator/denominator with a max cap.
// 3.69% = 369 / 10000.
// the SDK takes number | Long here; both values are small and exact
const feeNumerator = agentBps;
const feeDenominator = 10_000;

const sdk = await import('@hiero-ledger/sdk').catch(() => {
  console.error('install the SDK first: npm install @hiero-ledger/sdk @x402/hedera @x402/core');
  process.exit(1);
});

const {
  Client,
  PrivateKey,
  TokenCreateTransaction,
  TokenType,
  TokenSupplyType,
  CustomFractionalFee,
  FeeAssessmentMethod,
  Hbar,
} = sdk;

const client = Client.forName((process.env.HEDERA_NETWORK ?? 'hedera:testnet').replace('hedera:', ''));
client.setOperator(treasuryId, PrivateKey.fromStringECDSA(treasuryKey));

console.log(`creating OSOTIP on ${process.env.HEDERA_NETWORK ?? 'hedera:testnet'}`);
console.log(`  treasury : ${treasuryId}`);
console.log(`  artist   : ${artistId} (${(10_000 - agentBps) / 100}%)`);
console.log(`  compute  : ${computeId} (${agentBps / 100}% custom fee)`);

const fractional = new CustomFractionalFee()
  .setFeeCollectorAccountId(computeId)
  .setNumerator(feeNumerator)
  .setDenominator(feeDenominator)
  .setAssessmentMethod(FeeAssessmentMethod.Inclusive)
  // a demo tip should never be swallowed by the fee cap
  .setMax(Hbar.fromTinybars(1_000_000).toTinybars())
  .setAllCollectorsAreExempt(true);

const tx = await new TokenCreateTransaction()
  .setTokenName('OSO Artist Tip')
  .setTokenSymbol('OSOTIP')
  .setDecimals(decimals)
  .setInitialSupply(0)
  .setTreasuryAccountId(treasuryId)
  .setTokenType(TokenType.FungibleCommon)
  .setSupplyType(TokenSupplyType.Infinite)
  .setCustomFees([fractional])
  .freezeWith(client)
  .sign(PrivateKey.fromStringECDSA(treasuryKey));

const resp = await tx.execute(client);
const receipt = await resp.getReceipt(client);
const tokenId = receipt.tokenId?.toString();

if (!tokenId) {
  console.error('token creation did not return an id — check the receipt in HashScan');
  process.exit(1);
}

const network = (process.env.HEDERA_NETWORK ?? 'hedera:testnet').replace('hedera:', '');
console.log('\ncreated ✔');
console.log(`  token id : ${tokenId}`);
console.log(`  HashScan : https://hashscan.io/${network}/token/${tokenId}`);
console.log(`\nnext: set HEDERA_ASSET=${tokenId} in payments/.env and restart.`);
console.log('      the artist account must be associated with the token before any tip.');
