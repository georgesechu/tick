import type { MemoryStore, MemoryOperationExecutor } from '../../core/interfaces.js'
import type { MemoryOp, MemoryOpResult } from '../../core/types.js'

export class DefaultMemoryOperationExecutor implements MemoryOperationExecutor {
  constructor(private store: MemoryStore) {}

  async execute(ops: MemoryOp[]): Promise<MemoryOpResult[]> {
    const results: MemoryOpResult[] = []

    for (const op of ops) {
      try {
        results.push(await this.executeOne(op))
      } catch (err) {
        results.push({
          op: op.op,
          key: 'key' in op ? op.key : undefined,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return results
  }

  private async executeOne(op: MemoryOp): Promise<MemoryOpResult> {
    const key = 'key' in op ? op.key : undefined

    switch (op.op) {
      case 'set': {
        await this.store.set(op)
        return { op: 'set', key: op.key, success: true }
      }
      case 'get': {
        const entry = await this.store.get(op.key)
        return { op: 'get', key: op.key, success: true, data: entry ?? undefined }
      }
      case 'delete': {
        await this.store.delete(op.key)
        return { op: 'delete', key: op.key, success: true }
      }
      case 'append': {
        await this.store.append(op.key, op.value)
        return { op: 'append', key: op.key, success: true }
      }
      case 'list': {
        const entries = await this.store.list(op.prefix)
        return { op: 'list', success: true, data: entries }
      }
      case 'search': {
        const entries = await this.store.search(op.query, op.limit)
        return { op: 'search', success: true, data: entries }
      }
      case 'pin': {
        await this.store.pin(op.key)
        return { op: 'pin', key: op.key, success: true }
      }
      case 'unpin': {
        await this.store.unpin(op.key)
        return { op: 'unpin', key: op.key, success: true }
      }
      case 'set_ttl': {
        await this.store.setTTL(op.key, op.ttl)
        return { op: 'set_ttl', key: op.key, success: true }
      }
      case 'summarize_and_archive': {
        // TODO: invoke LLM to summarize, then archive
        return { op: 'summarize_and_archive', key: op.key, success: true }
      }
      case 'rollback': {
        await this.store.rollback(op.key, op.toVersion)
        return { op: 'rollback', key: op.key, success: true }
      }
      case 'history': {
        const entries = await this.store.history(op.key)
        return { op: 'history', key, success: true, data: entries }
      }
    }
  }
}
