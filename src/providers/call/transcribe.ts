import * as fs from 'node:fs'
import * as path from 'node:path'

export interface WhisperConfig {
  backend: 'openai' | 'groq'
  apiKey: string
}

const BACKENDS = {
  openai: {
    url: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
  },
}

/**
 * Transcribe an audio file via OpenAI or Groq whisper API.
 *
 * Both expose the same OpenAI-compatible /audio/transcriptions endpoint,
 * so the request shape is identical — only the base URL and model differ.
 *
 * Falls back gracefully: returns null on any error (callers skip).
 */
export async function transcribeChunk(
  filePath: string,
  config: WhisperConfig,
): Promise<string | null> {
  if (!config.apiKey) {
    console.error('[transcribe] WHISPER_API_KEY not set')
    return null
  }
  if (!fs.existsSync(filePath)) {
    console.error(`[transcribe] file not found: ${filePath}`)
    return null
  }

  const backend = BACKENDS[config.backend]
  if (!backend) {
    console.error(`[transcribe] unknown backend: ${config.backend}`)
    return null
  }

  try {
    const buf = fs.readFileSync(filePath)
    const file = new File([new Uint8Array(buf)], path.basename(filePath))

    const fd = new FormData()
    fd.append('file', file)
    fd.append('model', backend.model)
    fd.append('response_format', 'json')
    fd.append('language', 'en')

    const res = await fetch(backend.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: fd,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[transcribe] ${config.backend} ${res.status}: ${body.slice(0, 200)}`)
      return null
    }

    const json: any = await res.json()
    const text = String(json.text ?? '').trim()
    if (!text) return null

    console.log(`[transcribe] OK (${config.backend}): ${text.length} chars from ${path.basename(filePath)}`)
    return text
  } catch (err) {
    console.error('[transcribe] failed:', (err as Error).message)
    return null
  }
}
