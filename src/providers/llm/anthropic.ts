import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider } from '../../core/interfaces.js'
import type { LLMRequest, LLMResponse } from '../../core/types.js'

export class AnthropicLLMProvider implements LLMProvider {
  private client: Anthropic

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : undefined)
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const system = request.messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n\n')

    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0,
      ...(system ? { system } : {}),
      messages,
    })

    const content = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')

    return {
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }
  }
}
