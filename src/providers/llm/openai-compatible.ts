import type { LLMProvider } from '../../core/interfaces.js'
import type { LLMRequest, LLMResponse } from '../../core/types.js'

/**
 * Works with any OpenAI-compatible API:
 *   - OpenAI:    baseUrl = "https://api.openai.com/v1"
 *   - x.ai:      baseUrl = "https://api.x.ai/v1"
 *   - Together:   baseUrl = "https://api.together.xyz/v1"
 *   - Groq:       baseUrl = "https://api.groq.com/openai/v1"
 *   - Fireworks:  baseUrl = "https://api.fireworks.ai/inference/v1"
 *   - Ollama:     baseUrl = "http://localhost:11434/v1"
 *   - OpenRouter: baseUrl = "https://openrouter.ai/api/v1"
 */
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const system = request.messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n\n')

    const messages = [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      ...request.messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ]

    const body = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      temperature: request.temperature ?? 0,
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM API error ${res.status}: ${text}`)
    }

    const data = await res.json() as OpenAIChatResponse

    const content = data.choices[0]?.message?.content ?? ''

    return {
      content,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    }
  }
}

interface OpenAIChatResponse {
  choices: Array<{
    message: { role: string; content: string }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
