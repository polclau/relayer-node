import Web3 from 'web3'
import { EventLog } from 'web3/types'
import Contract from 'web3/eth/contract'

import { db } from '../database'
import { ERC20ABI, uniswapFactoryABI, uniswapexABI } from '../contracts'
import { retryAsync, logger, asyncBatch } from '../utils'
import { buildId } from '../book/utils'


export default class Indexer {
  w3: Web3
  uniswapFactory: Contract
  uniswapex: Contract
  lastMonitored: number
  uniswapTokenCache: { [key: string]: string }

  constructor(web3: Web3) {
    const {
      FROM_BLOCK,
      UNISWAP_FACTORY_CONTRACT,
      UNISWAPEX_CONTRACT
    } = process.env

    this.w3 = web3
    this.uniswapFactory = new web3.eth.Contract(
      uniswapFactoryABI,
      UNISWAP_FACTORY_CONTRACT
    )
    this.uniswapex = new web3.eth.Contract(uniswapexABI, UNISWAPEX_CONTRACT)
    this.lastMonitored = Number(FROM_BLOCK as string)
    this.uniswapTokenCache = {}
  }

  async getOrders(
    toBlock: number,
    onRawOrder: (data: string, event: EventLog) => Promise<void>
  ) {
    if (toBlock <= this.lastMonitored) {
      logger.debug(`Indexer: skip getOrders, ${this.lastMonitored}-${toBlock}`)
      return
    }

    logger.debug(`Indexer: getOrders, ${this.lastMonitored}-${toBlock}`)

    const total = await retryAsync(
      this.uniswapFactory.methods.tokenCount().call()
    ) // @TODO: use cache

    let tokensChecked = 0

    // Load ETH orders
    const events = await retryAsync(
      this.getSafePastEvents(
        this.uniswapex,
        'DepositETH',
        this.lastMonitored,
        toBlock
      )
    )

    logger.debug(`Indexer: Found ${events.length} ETH orders events`)

    for (const event of events) {
      const orderId = buildId(event)
      if (!(await db.existOrder(orderId))) {
        logger.info(`Indexer: Found ETH Order ${event.transactionHash}`)
        await onRawOrder(event.returnValues._data, event)
      } else {
        logger.info(`Indexer: Found already indexed ETH Order id: ${orderId}`)
      }
    }

    // Load events of all Uniswap tokens

    const addressesIndex = []
    for (let i = 1; i <= total; i++) {
      addressesIndex.push(i)
    }

    await asyncBatch({
      elements: addressesIndex,
      callback: async (indexesBatch: any[]) => {
        const promises = indexesBatch.map(async (index: number) => {
          const tokenAddr = await this.getUniswapAddress(index)
          tokensChecked++

          // Skip USDT
          if (
            tokenAddr.toLowerCase() == '0xdac17f958d2ee523a2206206994597c13d831ec7'
          ) {
            logger.debug(`Indexer: Skip token USDT`)
            return
          }

          logger.info(
            `Indexer: ${tokensChecked}/${total} - Monitoring token ${tokenAddr}`
          )


          const token = new this.w3.eth.Contract(ERC20ABI, tokenAddr)

          const events = await retryAsync(
            this.getSafePastEvents(token, 'Transfer', this.lastMonitored, toBlock)
          )

          logger.info(
            `Indexer: Found ${events.length} token transfer events for ${tokenAddr}`
          )

          const checked: string[] = []
          let checkedCount = 0

          await asyncBatch({
            elements: events,
            callback: async (eventsBatch: EventLog[]) => {
              const promises = eventsBatch.map(async (event: EventLog) => {
                const tx = event.transactionHash
                const orderId = buildId(event)
                checkedCount += 1

                if (checked.includes(tx)) {
                  return
                }

                if (await db.existOrder(orderId)) {
                  logger.info(`Indexer: Found already indexed Token Order id: ${orderId}`)
                  return
                }

                logger.debug(`Check tx: ${tx}`)
                const fullTx = await retryAsync(this.w3.eth.getTransaction(tx))
                const txData = fullTx ? fullTx.input : ''

                logger.debug(
                  `Indexer: ${checkedCount}/${events.length} - Check TX ${tx}`
                )
                if (txData.startsWith('0xa9059cbb') && txData.length == 714) { // use a variable and change to support contract wallets
                  logger.info(
                    `Indexer: Found token order ${token.options.address} ${tx}`
                  )
                  await onRawOrder(txData, event)
                }

                checked.push(tx)
              })

              await Promise.all(promises)
            },
            batchSize: 50, // env.get('BATCH_SIZE'),
            retryAttempts: 20
          })
        })
        await Promise.all(promises)
      },
      batchSize: 1, // env.get('BATCH_SIZE'),
      retryAttempts: 20
    })

    logger.info(
      `Indexer: Finished getOrders for range ${this.lastMonitored}-${toBlock}`
    )
    this.lastMonitored = toBlock
  }

  async getSafePastEvents(
    contract: Contract,
    name: string,
    fromBlock: number,
    toBlock: number
  ): Promise<EventLog[]> {
    try {
      return await contract.getPastEvents(name, {
        fromBlock: fromBlock,
        toBlock: toBlock
      })
    } catch (e) {
      if (
        fromBlock != toBlock &&
        e.toString().includes('more than 10000 results')
      ) {
        const pivot = Math.floor(fromBlock + (toBlock - fromBlock) / 2)
        logger.debug(
          `Indexer: ${contract.options.address} - Split event query in two ${fromBlock}-${toBlock} -> ${pivot}`
        )

        const result = await Promise.all([
          this.getSafePastEvents(contract, name, fromBlock, pivot),
          this.getSafePastEvents(contract, name, pivot, toBlock)
        ])

        return [...result[0], ...result[1]]
      } else {
        throw e
      }
    }
  }

  async getUniswapAddress(index: number): Promise<string> {
    if (this.uniswapTokenCache[index] != undefined) {
      return this.uniswapTokenCache[index]
    }

    const tokenAddr = await retryAsync(
      this.uniswapFactory.methods.getTokenWithId(index).call()
    )
    this.uniswapTokenCache[index] = tokenAddr
    return tokenAddr
  }
}
