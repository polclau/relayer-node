import Book from '../book'
import Relayer from '../relayer'
import { retryAsync, logger } from '../utils'
import { db } from '../database'

export default class Executor {
  book: Book
  relayer: Relayer

  constructor(book: Book, relayer: Relayer) {
    this.book = book
    this.relayer = relayer
  }

  async watchRound() {
    const allOrders = await db.getPendingOrders()

    for (const order of allOrders) {
      const exists = await retryAsync(this.book.exists(order))

      logger.debug(`Executor: Loaded order ${order.txHash}`)

      if (exists) {
        // Check if order is ready to be filled and it's still pending
        if (await this.book.canExecute(order)) {
          logger.verbose(`Executor: Filling order ${order.txHash}`)
          // Fill order, retry only 4 times
          const result = await retryAsync(this.relayer.fillOrder(order), 4)

          if (result != undefined) {
            // this.book.setFilled(order, result)
            await db.saveOrder({ ...order, executedTx: result })
          }
        } else {
          logger.debug(`Executor: Order not ready to be filled ${order.txHash}`)
        }
      } else {
        logger.verbose(
          `Executor: Order ${order.txHash} no long exists, removing it from pool`
        )
        // Set order as filled
        await db.saveOrder({ ...order, executedTx: '0x' })
      }
    }
  }
}
