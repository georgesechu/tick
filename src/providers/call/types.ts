// Call session and segment types

export interface CallSession {
  callId: string
  startedAt: string           // ISO
  endedAt: string | null
  tabTitle: string
  tabUrl: string
  status: 'active' | 'ended'
  totalSegments: number
  totalDurationSec: number
}

export interface CallSegment {
  id: string
  callId: string
  segmentIndex: number
  transcript: string
  durationSec: number
  createdAt: string           // ISO
}

/** What the context assembler sees for an active call */
export interface ActiveCallContext {
  callId: string
  tabTitle: string
  tabUrl: string
  elapsedSec: number
  totalSegments: number
  latestTranscript: string | null   // last segment's text (hot memory)
}

export interface CallStore {
  /** Create a new call session, return callId */
  createCall(tabTitle: string, tabUrl: string): string

  /** Add a transcribed segment to a call */
  addSegment(callId: string, transcript: string, durationSec: number): void

  /** End a call session */
  endCall(callId: string): void

  /** Get active call (if any) */
  getActiveCall(): ActiveCallContext | null

  /** Get a call session by ID */
  getCall(callId: string): CallSession | null

  /** Get all segments for a call */
  getSegments(callId: string): CallSegment[]

  /** Get the latest N segments for a call */
  getLatestSegments(callId: string, n: number): CallSegment[]

  /** Search across all call transcripts */
  searchTranscripts(query: string, limit?: number): Array<{ callId: string; segmentIndex: number; transcript: string; createdAt: string }>
}
