import type { Clock } from '../core/index.js'

export class RealClock implements Clock {
  now(): Date {
    return new Date()
  }
}
