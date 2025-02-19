import { sql } from "../utils/db";
import { insertTransactionRows } from "../utils/wrappa/postgres/write";
import { getBridgeID } from "../utils/wrappa/postgres/query";
import dayjs from "dayjs";
import { getCache, setCache } from "../utils/cache";
import { processLayerZeroData } from "../adapters/layerzero";
import { insertConfigEntriesForAdapter } from "../utils/adapter";
import { adapter } from "../adapters/layerzero";

const PROCESSED_FILES_KEY = "layerzero_processed_csv";
const BATCH_SIZE = 250;

export const handler = async () => {
  try {
    const processedFilesStr = (await getCache(PROCESSED_FILES_KEY)) || "[]";
    const processedFiles: Set<string> = new Set(JSON.parse(processedFilesStr));
    await insertConfigEntriesForAdapter(adapter, "layerzero");

    const bridgeIds = Object.fromEntries(
      await Promise.all(
        Object.keys(adapter).map(async (chain) => {
          chain = chain.toLowerCase();
          const bridgeId = await getBridgeID("layerzero", chain);
          return [chain, bridgeId?.id];
        })
      )
    );

    console.log(bridgeIds);

    console.log(`Previously processed files: ${processedFiles.size}`);

    const fileProcessor = processLayerZeroData("defillama-share", processedFiles);

    for await (const { fileName, transactions } of fileProcessor) {
      const totalTransactions = transactions.length;
      let processedCount = 0;

      for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
        const batch = transactions.slice(i, i + BATCH_SIZE);

        await sql.begin(async (sql) => {
          const sourceTransactions = [];
          const destinationTransactions = [];

          for (const tx of batch) {
            const {
              timestampSource,
              txHashSource,
              txHashDestination,
              chainSource,
              chainDestination,
              token,
              usdAmount,
              eoaAddressFrom,
              eoaAddressTo,
            } = tx;

            const sourceChain = chainSource.toLowerCase();
            const destinationChain = chainDestination.toLowerCase();
            const timestamp = dayjs(timestampSource).valueOf();

            if (bridgeIds[sourceChain]) {
              sourceTransactions.push({
                bridge_id: bridgeIds[sourceChain],
                chain: sourceChain,
                tx_hash: txHashSource,
                ts: timestamp,
                tx_block: null,
                tx_from: eoaAddressFrom ?? "0x",
                tx_to: eoaAddressTo ?? "0x",
                token: token ?? "0x0000000000000000000000000000000000000000",
                amount: usdAmount.toString(),
                is_deposit: true,
                is_usd_volume: true,
                txs_counted_as: 1,
                origin_chain: null,
              });
            }

            if (bridgeIds[destinationChain]) {
              destinationTransactions.push({
                bridge_id: bridgeIds[destinationChain],
                chain: destinationChain,
                tx_hash: txHashDestination,
                ts: timestamp,
                tx_block: null,
                tx_from: eoaAddressTo ?? "0x",
                tx_to: eoaAddressFrom ?? "0x",
                token: token ?? "0x0000000000000000000000000000000000000000",
                amount: usdAmount.toString(),
                is_deposit: false,
                is_usd_volume: true,
                txs_counted_as: 1,
                origin_chain: null,
              });
            }
          }

          try {
            if (sourceTransactions.length > 0) {
              await insertTransactionRows(sql, true, sourceTransactions, "upsert");
            }
            if (destinationTransactions.length > 0) {
              await insertTransactionRows(sql, true, destinationTransactions, "upsert");
            }
          } catch (error) {
            console.error(`Error inserting LayerZero batch:`, error);
            throw error;
          }

          processedCount += batch.length;
          const progress = ((processedCount / totalTransactions) * 100).toFixed(2);
          console.log(
            `Progress: ${progress}% - Inserted ${processedCount}/${totalTransactions} transactions from ${fileName}`
          );
        });
      }

      processedFiles.add(fileName);
      await setCache(PROCESSED_FILES_KEY, JSON.stringify([...processedFiles]), null);
      console.log(`Completed processing file: ${fileName}`);
    }
  } catch (error) {
    console.error("Error processing LayerZero events:", error);
    throw error;
  }
};

export default handler;
